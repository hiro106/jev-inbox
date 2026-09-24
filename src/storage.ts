import { parseWorkspace, type Workspace } from '../shared/domain';
import { createSeedTickets } from '../shared/demo';

export const STORAGE_KEY = 'jev-inbox.workspace.v1';
export function freshWorkspace(): Workspace {
  return { version: 1, tickets: createSeedTickets(), threshold: 0.8 };
}
export function loadWorkspace(): { workspace: Workspace; error: string | null; blocked: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return {
      workspace: raw ? parseWorkspace(JSON.parse(raw)) : freshWorkspace(),
      error: null,
      blocked: false,
    };
  } catch {
    return {
      workspace: { version: 1, tickets: [], threshold: 0.8 },
      error:
        '保存データを読み込めませんでした。元のデータは上書きしていません。設定からバックアップを取得し、初期化してください。',
      blocked: true,
    };
  }
}
export function downloadFile(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
