/**
 * Project identity resolution.
 *
 * A ledger is only trustworthy if findings cannot leak across projects, so every
 * row is attached to a project identity. We prefer the git remote (a checkout can
 * move on disk and still be the same project) and fall back to the absolute
 * directory. Resolved without spawning `git`, so it works in sandboxes where a
 * child process is unavailable.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const GIT_REMOTE_RE = /^\s*\[remote\s+"origin"\]\s*$/m;

/** Normalize a git remote URL so https/ssh/scp spellings collapse to one key. */
export function normalizeRemote(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let value = url.trim().replace(/^git\+/, '');
  // scp-style: git@github.com:owner/repo.git
  const scp = /^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/.exec(value);
  if (scp && !value.includes('://')) {
    value = `https://${scp[2]}/${scp[3]}`;
  }
  value = value.replace(/^ssh:\/\//i, 'https://').replace(/^git:\/\//i, 'https://');
  value = value.replace(/^https?:\/\//i, '');
  // Drop credentials.
  value = value.replace(/^[^@/]*@/, '');
  value = value.replace(/\/+$/, '').replace(/\.git$/i, '');
  return value.toLowerCase();
}

function findGitDirectory(start) {
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, '.git');
    if (existsSync(candidate)) {
      try {
        const stat = statSync(candidate);
        if (stat.isDirectory()) return { root: current, gitDir: candidate };
        // Worktree / submodule: `.git` is a file pointing at the real gitdir.
        const text = readFileSync(candidate, 'utf8');
        const match = /^gitdir:\s*(.+)$/m.exec(text);
        if (match) {
          const gitDir = resolve(current, match[1].trim());
          if (existsSync(gitDir)) return { root: current, gitDir };
        }
        return { root: current, gitDir: null };
      } catch {
        return { root: current, gitDir: null };
      }
    }
    const parent = dirname(current);
    if (parent === current || current === sep) return null;
    current = parent;
  }
}

function readOriginUrl(gitDir) {
  if (!gitDir) return null;
  const configPath = join(gitDir, 'config');
  if (!existsSync(configPath)) return null;
  try {
    const text = readFileSync(configPath, 'utf8');
    if (!GIT_REMOTE_RE.test(text)) return null;
    const sectionStart = text.search(GIT_REMOTE_RE);
    const rest = text.slice(sectionStart);
    const nextSection = rest.slice(1).search(/^\s*\[/m);
    const body = nextSection === -1 ? rest : rest.slice(0, nextSection + 1);
    const urlMatch = /^\s*url\s*=\s*(.+)$/m.exec(body);
    return urlMatch ? urlMatch[1].trim() : null;
  } catch {
    return null;
  }
}

const expandHome = (input) => {
  if (typeof input !== 'string') return input;
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return input;
};

/**
 * Resolve `{ identityKey, displayName, gitRemote, rootPathHint }` for a
 * directory, or for an explicit identity string.
 */
export function resolveProject(directory) {
  const root = resolve(expandHome(directory ?? process.cwd()));
  const git = findGitDirectory(root);
  const gitRemote = git ? readOriginUrl(git.gitDir) : null;
  const remoteKey = normalizeRemote(gitRemote);
  if (remoteKey) {
    const repo = remoteKey.split('/').slice(-1)[0] || remoteKey;
    return {
      identityKey: `git:${remoteKey}`,
      displayName: repo,
      gitRemote,
      rootPathHint: git ? git.root : root,
    };
  }
  return {
    identityKey: `dir:${root.toLowerCase()}`,
    displayName: basename(root) || root,
    gitRemote: null,
    rootPathHint: root,
  };
}

/** Accept an explicit project selector: a path, a `git:`/`dir:` key, or a bare remote. */
export function resolveProjectFromSelector(selector) {
  if (typeof selector !== 'string' || selector.trim() === '') return null;
  const value = selector.trim();
  if (value.startsWith('git:') || value.startsWith('dir:')) {
    const rest = value.slice(4);
    const display = value.startsWith('git:')
      ? rest.split('/').slice(-1)[0] || rest
      : basename(rest) || rest;
    return {
      identityKey: value.startsWith('git:') ? `git:${normalizeRemote(rest) ?? rest}` : `dir:${rest.toLowerCase()}`,
      displayName: display,
      gitRemote: value.startsWith('git:') ? rest : null,
      rootPathHint: value.startsWith('git:') ? null : rest,
    };
  }
  if (existsSync(expandHome(value))) return resolveProject(value);
  const normalized = normalizeRemote(value);
  if (normalized && normalized.includes('/')) {
    return {
      identityKey: `git:${normalized}`,
      displayName: normalized.split('/').slice(-1)[0],
      gitRemote: value,
      rootPathHint: null,
    };
  }
  return null;
}
