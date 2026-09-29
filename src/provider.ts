import * as http from 'http';
import * as https from 'https';
import { AssistantMessageEventStream } from './pi-compat';
import { prepareContext, validateContextLimits, validateRequestLimits } from './context';

export function validateBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含凭据、查询参数或片段');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('远程 API 必须使用 HTTPS；本机 API 可以使用 HTTP');
  return url.href.replace(/\/+$/, '');
}

export function createModel(id: string, baseUrl: string, limits?: any, requestLimits?: {maxOutputTokens: number}): any {
  const configured = validateContextLimits(limits || {});
  const validated = requestLimits ? validateRequestLimits({...configured, maxOutputTokens: requestLimits.maxOutputTokens}) : configured;
  return { id, name: id, api: 'openai-completions', provider: 'custom', baseUrl,
    reasoning: false, input: ['text'], contextWindow: validated.contextWindow, maxTokens: validated.maxOutputTokens,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0} };
}

function contentText(content: any): string {
  return typeof content === 'string' ? content : (content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}

export function toOpenAIMessages(context: any): any[] {
  const messages: any[] = [];
  if (context.systemPrompt) messages.push({role: 'system', content: context.systemPrompt});
  for (const item of context.messages) {
    if (item.role === 'user') messages.push({role: 'user', content: contentText(item.content)});
    if (item.role === 'toolResult') messages.push({role: 'tool', tool_call_id: item.toolCallId, content: contentText(item.content)});
    if (item.role === 'assistant' && !['error', 'aborted'].includes(item.stopReason)) {
      const msg: any = {role: 'assistant', content: contentText(item.content) || null};
      const calls = item.content.filter((c: any) => c.type === 'toolCall');
      if (calls.length) msg.tool_calls = calls.map((c: any) => ({id: c.id, type: 'function', function: {name: c.name, arguments: JSON.stringify(c.arguments)}}));
      messages.push(msg);
    }
  }
  return messages;
}

function retryDelay(milliseconds: number, signal?: any): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('已取消')); return; }
    const abort = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); reject(new Error('已取消')); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    if (signal) { signal.addEventListener('abort', abort, {once: true}); if (signal.aborted) abort(); }
  });
}

function responseError(status: number, body: string): any {
  // Error bodies can contain credentials. Inspect a bounded copy internally and
  // expose only a fixed message/status, never the provider's arbitrary text.
  let diagnostic = body;
  try {
    const parsed = JSON.parse(body);
    const detail = parsed && parsed.error || parsed;
    diagnostic = detail && typeof detail === 'object' ? [detail.code, detail.type, detail.message].filter(value => typeof value === 'string').join(' ') : String(detail || '');
  } catch (_) { /* Some gateways return plain text. */ }
  const overflow = status === 400 && /context[_ -](?:length|window)[_ -]exceeded|maximum context (?:length|window)|context (?:length|window).{0,80}(?:exceed|too (?:long|large)|limit)|prompt (?:is )?too long|上下文.{0,40}(?:超出|超过|上限)/i.test(diagnostic);
  const error: any = new Error(overflow ? '模型服务报告上下文超出窗口，请压缩会话或检查模型窗口设置' : '模型 API 返回 HTTP ' + status + '；请检查地址、模型、密钥和额度');
  error.statusCode = status;
  if (overflow) error.code = 'CONTEXT_OVERFLOW';
  error.retryable = [429, 500, 502, 503, 504].includes(status);
  return error;
}

// Use Node's native HTTP stack: no fetch, provider SDK or native addon at runtime.
export function streamCompatible(model: any, context: any, options: any = {}): any {
  const stream = new AssistantMessageEventStream();
  const message: any = {role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: 'stop',
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
  Promise.resolve().then(async () => {
    try {
      if (options.signal && options.signal.aborted) throw new Error('已取消');
      stream.push({type: 'start', partial: message});
      let activeContext = options.prepareRequest ? await options.prepareRequest(context, options.signal) : context;
      let transientRetries = 0;
      let overflowRetried = false;
      while (true) {
        if (options.signal && options.signal.aborted) throw new Error('已取消');
        const prepared = prepareContext(activeContext.messages, activeContext.systemPrompt || '', activeContext.tools || [], {contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens}, {allowTruncation: options.allowTruncation !== false});
        if (options.onContext) options.onContext(prepared.stats);
        try {
          await requestStream(model, {...activeContext, messages: prepared.messages}, options, message, stream);
          break;
        } catch (error) {
          const failure: any = error;
          // Once any assistant text or tool-call fragment arrived, replaying the
          // request could duplicate an answer or operation. Never retry that run.
          const beforeOutput = message.content.length === 0;
          if (beforeOutput && failure.code === 'CONTEXT_OVERFLOW' && options.autoCompactEnabled && options.prepareRequest && !overflowRetried) {
            overflowRetried = true;
            if (options.onRetry) options.onRetry({reason: 'context_overflow', attempt: 1, delayMs: 0});
            activeContext = await options.prepareRequest(context, options.signal, true);
            continue;
          }
          if (beforeOutput && failure.retryable && transientRetries < 3 && !(options.signal && options.signal.aborted)) {
            const delayMs = Math.min(8000, 2000 * Math.pow(2, transientRetries++));
            if (options.onRetry) options.onRetry({reason: 'transient', statusCode: failure.statusCode, attempt: transientRetries, maxRetries: 3, delayMs});
            await retryDelay(delayMs, options.signal);
            continue;
          }
          throw error;
        }
      }
      stream.push({type: 'done', reason: message.stopReason, message});
    } catch (error) {
      message.stopReason = options.signal && options.signal.aborted ? 'aborted' : 'error';
      let text = error instanceof Error ? error.message : String(error);
      if (options.apiKey) text = text.split(options.apiKey).join('[redacted]');
      message.errorMessage = text;
      stream.push({type: 'error', reason: message.stopReason, error: message});
    } finally { stream.end(message); }
  });
  return stream;
}

function requestStream(model: any, context: any, options: any, message: any, stream: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = validateBaseUrl(model.baseUrl);
    const endpoint = new URL(base + '/chat/completions');
    const payload: any = {model: model.id, messages: toOpenAIMessages(context), stream: true, max_tokens: model.maxTokens || 4096};
    if (context.tools && context.tools.length) {
      payload.tools = context.tools.map((tool: any) => ({type: 'function', function: {name: tool.name, description: tool.description, parameters: tool.parameters}}));
      payload.tool_choice = 'auto';
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) return reject(new Error('会话上下文超过 4 MB，请开启新会话'));
    const headers: any = {'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body)};
    if (options.apiKey) headers.Authorization = 'Bearer ' + options.apiKey;
    let settled = false;
    let response: http.IncomingMessage | undefined;
    let total = 0;
    let pending = '';
    let eventLines: string[] = [];
    let textIndex = -1;
    let terminal = false;
    let finishReason: string | null = null;
    const calls: {[key: number]: {index: number; raw: string}} = {};
    const client = endpoint.protocol === 'https:' ? https : http;
    const req = client.request(endpoint, {method: 'POST', headers}, res => {
      response = res;
      res.setEncoding('utf8');
      if (res.statusCode !== 200) {
        let errorBody = '';
        let errorBytes = 0;
        const status = res.statusCode || 0;
        res.on('data', (value: string) => {
          if (settled) return;
          const remaining = 65536 - errorBytes;
          const bytes = Buffer.from(value, 'utf8');
          errorBody += bytes.slice(0, Math.max(0, remaining)).toString('utf8');
          errorBytes += bytes.length;
          if (errorBytes >= 65536) finish(responseError(status, errorBody));
        });
        res.on('end', () => finish(responseError(status, errorBody)));
        res.on('error', () => finish(responseError(status, errorBody)));
        res.on('aborted', () => finish(responseError(status, errorBody)));
        return;
      }
      if (!(res.headers['content-type'] || '').includes('text/event-stream')) { finish(new Error('模型 API 未返回 SSE 流')); return; }
      res.on('data', (chunk: string) => {
        if (settled) return;
        try {
          total += Buffer.byteLength(chunk);
          if (total > 4 * 1024 * 1024) throw new Error('模型响应超过 4 MB');
          pending += chunk;
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
            if (line === '') { dispatch(); } else if (line.startsWith('data:')) eventLines.push(line.slice(5).replace(/^ /, ''));
          }
        } catch (error) { finish(error as Error); }
      });
      res.on('error', finish);
      res.on('aborted', () => finish(new Error('模型连接提前断开')));
      res.on('end', () => {
        if (settled) return;
        try {
          if (pending.startsWith('data:')) eventLines.push(pending.slice(5).trim());
          dispatch();
          if (!terminal && !finishReason) throw new Error('模型响应不完整，未收到结束标记');
          if (finishReason === 'length' || finishReason === 'content_filter') throw new Error('模型响应被截断或拦截，未执行不完整的工具调用');
          Object.keys(calls).forEach(key => {
            const info = calls[Number(key)]; const block = message.content[info.index];
            if (!block.id || !block.name) throw new Error('模型工具调用缺少标识或名称');
            block.arguments = JSON.parse(info.raw || '{}');
            stream.push({type: 'toolcall_end', contentIndex: info.index, toolCall: block, partial: message});
          });
          message.stopReason = Object.keys(calls).length ? 'toolUse' : 'stop';
          finish();
        } catch (error) { finish(error as Error); }
      });
    });
    const abort = () => finish(new Error('已取消'));
    const deadline = setTimeout(() => finish(new Error('模型请求超过 180 秒')), 180000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (options.signal) options.signal.removeEventListener('abort', abort);
      if (error) { if (response) response.destroy(); req.destroy(); reject(error); } else resolve();
    }
    function dispatch() {
      if (!eventLines.length) return;
      const data = eventLines.join('\n'); eventLines = [];
      if (data === '[DONE]') { terminal = true; return; }
      const event = JSON.parse(data);
      if (event.error) throw new Error('模型流返回错误，请检查 API 配置或额度');
      if (event.usage) {
        message.usage.input = event.usage.prompt_tokens || 0;
        message.usage.output = event.usage.completion_tokens || 0;
        message.usage.totalTokens = event.usage.total_tokens || message.usage.input + message.usage.output;
      }
      const choice = event.choices && event.choices[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        if (textIndex < 0) { textIndex = message.content.length; message.content.push({type: 'text', text: ''}); }
        message.content[textIndex].text += delta.content;
        stream.push({type: 'text_delta', contentIndex: textIndex, delta: delta.content, partial: message});
      }
      for (const call of delta.tool_calls || []) {
        if (!Number.isInteger(call.index) || call.index < 0 || call.index > 32) throw new Error('模型工具索引无效');
        if (!calls[call.index]) {
          calls[call.index] = {index: message.content.length, raw: ''};
          message.content.push({type: 'toolCall', id: '', name: '', arguments: {}});
        }
        const info = calls[call.index]; const block = message.content[info.index];
        if (call.id) block.id = call.id;
        if (call.function && call.function.name) block.name += call.function.name;
        if (call.function && call.function.arguments) info.raw += call.function.arguments;
      }
    }
    req.on('error', (error: any) => {
      if (!response && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) error.retryable = true;
      finish(error);
    });
    req.setTimeout(60000, () => finish(new Error('模型连接 60 秒没有响应')));
    if (options.signal) {
      options.signal.addEventListener('abort', abort, {once: true});
      if (options.signal.aborted) { abort(); return; }
    }
    req.end(body);
  });
}
