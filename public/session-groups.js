(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PiSessionGroups = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function segments(value) {
    const result = [];
    value.split('/').forEach(function (part) {
      if (!part || part === '.') return;
      if (part === '..') { result.pop(); return; }
      result.push(part);
    });
    return result;
  }

  // Resolve spelling differences without resolving files: old workspaces may
  // no longer exist. Keep UNC share roots and distinct full paths separate.
  function workspaceInfo(value) {
    if (typeof value !== 'string' || !value.trim()) return { key: 'missing:', path: '', name: '未指定文件夹' };
    let input = value.trim().replace(/\\/g, '/');
    input = input.replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\/([a-z]:\/)/i, '$1');
    let full;
    if (/^[a-z]:\//i.test(input)) {
      full = input.slice(0, 2) + '/' + segments(input.slice(3)).join('/');
      return { key: 'win:' + full.toLowerCase(), path: full.replace(/\//g, '\\'), name: full.split('/').filter(Boolean).pop() + (full.length === 3 ? '\\' : '') };
    }
    if (input.slice(0, 2) === '//' && input.slice(2).split('/').filter(Boolean).length >= 2) {
      const parts = input.slice(2).split('/').filter(Boolean);
      full = '//' + parts.slice(0, 2).join('/') + (parts.length > 2 ? '/' + segments(parts.slice(2).join('/')).join('/') : '');
      full = full.replace(/\/$/, '');
      return { key: 'win:' + full.toLowerCase(), path: full.replace(/\//g, '\\'), name: full.split('/').pop() };
    }
    // POSIX paths remain case-sensitive; unknown legacy strings never alias a
    // Windows absolute path merely because they share a last directory name.
    full = input.charAt(0) === '/' ? '/' + segments(input).join('/') : input.replace(/\/+$/, '');
    return { key: 'path:' + full, path: full, name: full.split('/').filter(Boolean).pop() || full };
  }

  function timestamp(value) {
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : 0;
    return Number.isFinite(number) ? number : 0;
  }
  function searchText(value) { return String(value || '').replace(/\\/g, '/').toLowerCase(); }
  function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function groupSessions(sessions, query) {
    const groups = new Map();
    (Array.isArray(sessions) ? sessions : []).forEach(function (session) {
      if (!session || typeof session !== 'object') return;
      const info = workspaceInfo(session.workspace);
      let group = groups.get(info.key);
      if (!group) {
        group = { key: info.key, name: info.name, path: info.path, sessions: [], totalCount: 0, updatedAt: 0, active: false };
        groups.set(info.key, group);
      }
      group.sessions.push(session);
      group.active = group.active || Boolean(session.active);
      if (group.totalCount === 0 || timestamp(session.updatedAt) > group.updatedAt) {
        group.path = info.path; group.name = info.name; group.updatedAt = timestamp(session.updatedAt);
      }
      group.totalCount++;
    });
    const term = searchText(query).trim();
    return Array.from(groups.values()).map(function (group) {
      group.sessions.sort(function (a, b) { return timestamp(b.updatedAt) - timestamp(a.updatedAt) || compareText(String(a.id || ''), String(b.id || '')); });
      if (term && searchText(group.path).indexOf(term) < 0 && searchText(group.name).indexOf(term) < 0) {
        group.sessions = group.sessions.filter(function (session) {
          return [session.title || '新会话', session.workspace, session.model, session.baseUrl].some(function (value) { return searchText(value).indexOf(term) >= 0; });
        });
      }
      return group;
    }).filter(function (group) { return group.sessions.length > 0; }).sort(function (a, b) {
      return b.updatedAt - a.updatedAt || compareText(a.key, b.key);
    });
  }

  function parseExpansion(raw) {
    const result = Object.create(null);
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
      Object.keys(value).forEach(function (key) {
        if (/^(win:|path:|missing:)/.test(key) && typeof value[key] === 'boolean') result[key] = value[key];
      });
    } catch (_) { /* Missing, damaged or unavailable browser preferences are optional. */ }
    return result;
  }

  function isExpanded(group, query, saved, searchOverrides) {
    const choices = String(query || '').trim() ? searchOverrides : saved;
    if (choices && Object.prototype.hasOwnProperty.call(choices, group.key)) return choices[group.key] === true;
    return String(query || '').trim() ? true : group.active;
  }

  return { workspaceInfo: workspaceInfo, groupSessions: groupSessions, parseExpansion: parseExpansion, isExpanded: isExpanded };
});
