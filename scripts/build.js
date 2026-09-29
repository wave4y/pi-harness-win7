'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const builtinModules = require('module').builtinModules;

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));

// The Pi npm packages omit their repository license file. This is the original
// license from the exact upstream v0.51.6 tag, retained verbatim for distribution:
// https://raw.githubusercontent.com/badlogic/pi-mono/v0.51.6/LICENSE
const piLicense = `MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function inspectBundle(meta) {
  for (const name of Object.keys(meta.inputs)) {
    const normalized = name.replace(/\\/g, '/');
    if (/\/pi-ai\/dist\/(providers|utils\/oauth)\//.test(normalized) ||
        /\/node_modules\/(openai|undici|@anthropic-ai|@aws-sdk|@google|@mistralai)\//.test('/' + normalized)) {
      throw new Error('Modern provider dependency unexpectedly bundled: ' + name);
    }
    if (/\.(node|dll|exe)$/i.test(name)) {
      throw new Error('Native runtime dependency unexpectedly bundled: ' + name);
    }
  }
  for (const artifact of Object.values(meta.outputs)) {
    for (const dependency of artifact.imports) {
      if (dependency.external && !builtins.has(dependency.path.replace(/^node:/, ''))) {
        throw new Error('Unbundled runtime dependency: ' + dependency.path);
      }
    }
  }
}

function bundledPackages(metas) {
  const packages = new Map();
  for (const meta of metas) {
    for (const name of Object.keys(meta.inputs)) {
      if (!name.replace(/\\/g, '/').includes('node_modules/')) continue;
      let directory = path.dirname(path.resolve(root, name));
      while (directory.startsWith(root + path.sep)) {
        const manifest = path.join(directory, 'package.json');
        if (fs.existsSync(manifest)) {
          const info = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          if (info.name && info.version) {
            packages.set(info.name + '@' + info.version, { directory, info });
            break;
          }
        }
        directory = path.dirname(directory);
      }
    }
  }
  return Array.from(packages.values()).sort((a, b) => a.info.name.localeCompare(b.info.name));
}

function writeNotices(packages) {
  const sections = ['Third-party components included in this distribution.\n' +
    'Generated from the actual bundle inputs; build-only and unused SDK packages are excluded.'];
  for (const component of packages) {
    const info = component.info;
    const files = fs.readdirSync(component.directory).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
    let licenses = files.filter(name => fs.statSync(path.join(component.directory, name)).isFile())
      .map(name => fs.readFileSync(path.join(component.directory, name), 'utf8'));
    if (licenses.length === 0 && /^@mariozechner\/pi-(agent-core|ai)$/.test(info.name)) {
      if (info.version !== '0.51.6') throw new Error('Refresh the upstream Pi license before changing the pinned version.');
      licenses = [piLicense];
    }
    if (licenses.length === 0) throw new Error('Missing license text for bundled component ' + info.name);
    sections.push(info.name + '@' + info.version + '\nLicense: ' + JSON.stringify(info.license) + '\n\n' + licenses.join('\n\n'));
  }
  fs.writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const results = {};
  const entries = { server: 'src/server.ts', persistence: 'src/persistence.ts', tools: 'src/local-tools.ts', folders: 'src/folder-browser.ts', context: 'src/context.ts', permissions: 'src/permissions.ts', mcp: 'src/mcp.ts', skills: 'src/skills.ts', compaction: 'src/compaction.ts', session: 'src/pi-session.ts', provider: 'src/provider.ts', 'pi-resources': 'src/pi-resources.ts', 'dsh-prompts': 'src/dsh-prompts.ts' };
  for (const name of Object.keys(entries)) {
    const result = await esbuild.build({
      absWorkingDir: root,
      entryPoints: [entries[name]],
      outfile: path.join(output, name + '.cjs'),
      bundle: true,
      platform: 'node',
      target: ['node12.22'],
      format: 'cjs',
      sourcemap: true,
      metafile: true,
      legalComments: 'inline',
      logLevel: 'info',
      plugins: [{
        name: 'pi-legacy-runtime',
        setup(build) {
          build.onResolve({ filter: /^@mariozechner\/pi-ai$/ }, () => ({ path: path.join(root, 'src/pi-compat.ts') }));
          // Node 12 cannot require node: prefixed builtins in CommonJS.
          build.onResolve({ filter: /^node:/ }, args => ({ path: args.path.slice(5), external: true }));
        },
      }],
    });
    inspectBundle(result.metafile);
    results[name] = result.metafile;
  }
  const packages = bundledPackages(Object.values(results));
  writeNotices(packages);
  const dshDirectory = path.join(root, 'public/dsh');
  if (fs.existsSync(dshDirectory)) {
    const upstream = ['PROVENANCE.txt', 'LICENSE.txt', 'Montserrat-OFL.txt']
      .map(name => fs.readFileSync(path.join(dshDirectory, name), 'utf8')).join('\n\n');
    fs.appendFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), '\n\nDeepSeek Harness UI and Montserrat fonts\n' + upstream);
  }
  for (const directory of ['src/vendor/pi-coding-agent', 'src/vendor/pi-resources', 'src/vendor/dsh-prompts']) {
    const provenance = path.join(root, directory, 'PROVENANCE.txt');
    if (fs.existsSync(provenance)) fs.appendFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), '\n\n' + fs.readFileSync(provenance, 'utf8'));
    const license = path.join(root, directory, 'LICENSE.txt');
    if (fs.existsSync(license)) fs.appendFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), '\n' + fs.readFileSync(license, 'utf8'));
  }
  fs.writeFileSync(path.join(output, 'build-meta.json'), JSON.stringify({
    appVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    nodeTarget: '12.22.12',
    browserTarget: 'chrome102',
    uiSource: 'deepseek-ai/deepseek-harness@639ed015397290b3745d163aafe02ffee4aa3f84',
    piVersion: '0.51.6',
    codingAgentModules: ['session-manager', 'messages', 'truncate', 'compaction prompts and policy', 'prompt-templates and project resource rules'],
    dshPromptSource: 'deepseek-ai/deepseek-harness@639ed015397290b3745d163aafe02ffee4aa3f84',
    runtimePackages: packages.map(item => ({ name: item.info.name, version: item.info.version, license: item.info.license })),
    bundles: results,
  }, null, 2) + '\n');
  copyDirectory(path.join(root, 'public'), path.join(output, 'public'));
  for (const name of ['app.js', 'session-groups.js']) {
    const browserResult = await esbuild.transform(fs.readFileSync(path.join(root, 'public', name), 'utf8'), {
      target: ['chrome102'], loader: 'js', legalComments: 'inline'
    });
    fs.writeFileSync(path.join(output, 'public', name), browserResult.code);
  }
  for (const filename of ['style.css', 'dsh/base.css', 'dsh/design-platform.css', 'dsh/gradient-shadow-text.css', 'dsh/brand-font.css', 'dsh/components.css']) {
    const source = path.join(root, 'public', filename);
    if (!fs.existsSync(source)) continue;
    const compiled = await esbuild.transform(fs.readFileSync(source, 'utf8'), {target: ['chrome102'], loader: 'css', legalComments: 'inline'});
    fs.writeFileSync(path.join(output, 'public', filename), compiled.code);
  }
  console.log('Built for Node 12.22.12; bundle checks passed (no provider SDKs, native addons or external npm dependencies).');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
