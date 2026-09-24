import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  Download,
  FileJson,
  Inbox,
  Layers3,
  ListFilter,
  LoaderCircle,
  MailPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import {
  applyDecision,
  categories,
  categoryLabels,
  categoryTeams,
  channels,
  decisionSchema,
  getCategory,
  getPriority,
  getStage,
  parseWorkspace,
  priorities,
  priorityLabels,
  priorityFromScore,
  reviewReasons,
  ticketInputSchema,
  toCsv,
  withHistory,
  type Category,
  type Priority,
  type Stage,
  type Ticket,
  type TicketInput,
  type Workspace,
} from '../shared/domain';
import {
  ChannelIcon,
  formatDate,
  Logo,
  Modal,
  PriorityBadge,
  SourceBadge,
  StageBadge,
} from './components';
import { downloadFile, freshWorkspace, loadWorkspace, STORAGE_KEY } from './storage';

type Filter = 'all' | Stage;
type Notice = { text: string; kind: 'success' | 'error' };
type Dialog = 'settings' | 'new' | 'help' | 'export' | 'reset' | 'delete' | 'edit' | null;
const filterLabels: Record<Filter, string> = {
  all: '受信トレイ',
  new: '未仕分け',
  review: '要確認',
  ready: '対応待ち',
  resolved: '対応済み',
};
const priorityOrder: Record<Priority, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

export function App() {
  const [initial] = useState(loadWorkspace);
  const [workspace, setWorkspace] = useState<Workspace>(initial.workspace);
  const [storageError, setStorageError] = useState(initial.error);
  const [storageBlocked, setStorageBlocked] = useState(initial.blocked);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    window.matchMedia('(min-width: 1081px)').matches
      ? (initial.workspace.tickets[0]?.id ?? null)
      : null,
  );
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [apiKey, setApiKey] = useState('');
  const [serverKey, setServerKey] = useState(false);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const { tickets, threshold } = workspace;
  const selected = tickets.find((t) => t.id === selectedId);
  const busy = busyIds.length > 0;

  useEffect(() => {
    if (storageBlocked) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
      setStorageError(null);
    } catch {
      setStorageError(
        'ブラウザへの保存に失敗しました。変更はこの画面に残っています。JSONを書き出して保管してください。',
      );
    }
  }, [workspace, storageBlocked]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const health = await res.json();
        setServerKey(health.hasServerKey === true);
        setApiOnline(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setApiOnline(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (notice?.kind !== 'success') return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const counts = useMemo(() => {
    const result: Record<Filter, number> = {
      all: tickets.length,
      new: 0,
      review: 0,
      ready: 0,
      resolved: 0,
    };
    for (const ticket of tickets) result[getStage(ticket, threshold)]++;
    return result;
  }, [tickets, threshold]);
  const visible = useMemo(
    () =>
      tickets
        .filter(
          (t) =>
            (filter === 'all' || getStage(t, threshold) === filter) &&
            (categoryFilter === 'all' || getCategory(t) === categoryFilter) &&
            `${t.subject} ${t.sender} ${t.body}`.toLowerCase().includes(query.toLowerCase().trim()),
        )
        .sort((a, b) =>
          sort === 'priority'
            ? priorityOrder[getPriority(b) ?? 'low'] - priorityOrder[getPriority(a) ?? 'low'] ||
              b.createdAt.localeCompare(a.createdAt)
            : b.createdAt.localeCompare(a.createdAt),
        ),
    [tickets, filter, categoryFilter, query, sort, threshold],
  );

  function notify(text: string, kind: Notice['kind'] = 'success') {
    setNotice({ text, kind });
  }
  function updateTicket(id: string, transform: (ticket: Ticket) => Ticket) {
    setWorkspace((w) => ({
      ...w,
      tickets: w.tickets.map((t) => (t.id === id ? transform(t) : t)),
    }));
  }
  function changeFilter(next: Filter) {
    setFilter(next);
    setSelectedId(null);
  }
  async function evaluate(items: Ticket[]) {
    if (busyRef.current || !items.length) return;
    if (mode === 'live' && !apiKey && !serverKey) {
      setDialog('settings');
      return;
    }
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusyIds(items.map((t) => t.id));
    setProgress({ current: 0, total: items.length });
    setNotice(null);
    let completed = 0;
    try {
      for (const ticket of items) {
        const res = await fetch('/api/evaluate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(mode === 'live' && apiKey ? { 'x-typesafe-api-key': apiKey } : {}),
          },
          body: JSON.stringify({
            mode,
            ticket: {
              subject: ticket.subject,
              body: ticket.body,
              sender: ticket.sender,
              channel: ticket.channel,
            },
          }),
          signal: controller.signal,
        });
        const raw: unknown = await res.json();
        if (!res.ok)
          throw new Error(
            typeof raw === 'object' && raw && 'error' in raw && typeof raw.error === 'string'
              ? raw.error
              : '仕分けに失敗しました。',
          );
        const parsed = decisionSchema.safeParse(raw);
        if (!parsed.success)
          throw new Error('判定結果の形式を確認できませんでした。保存せず停止しました。');
        const decision = parsed.data;
        if (decision.source !== mode)
          throw new Error('判定元が一致しないため、保存を停止しました。');
        updateTicket(ticket.id, (current) => applyDecision(current, decision));
        completed++;
        setProgress({ current: completed, total: items.length });
      }
      setApiOnline(true);
      notify(`${completed}件を${mode === 'demo' ? 'デモで' : 'Jevで'}仕分けしました。`);
    } catch (error) {
      const prefix = completed ? `${completed}件を保存済み。` : '';
      notify(
        controller.signal.aborted
          ? `${prefix}仕分けを中止しました。`
          : `${prefix}${error instanceof TypeError ? 'サーバーに接続できません。起動状態を確認してください。' : error instanceof Error ? error.message : '仕分けに失敗しました。'}`,
        'error',
      );
    } finally {
      busyRef.current = false;
      setBusyIds([]);
      setProgress(null);
      abortRef.current = null;
    }
  }
  function saveTicket(input: TicketInput) {
    if (dialog === 'edit' && selected) {
      updateTicket(selected.id, (t) =>
        withHistory(
          { ...t, ...input, decision: undefined, review: undefined, resolvedAt: undefined },
          '内容を編集し、仕分け結果をリセット',
        ),
      );
      notify('内容を更新しました。もう一度仕分けできます。');
    } else {
      if (tickets.length >= 200) {
        notify('保存できる問い合わせは200件までです。', 'error');
        return;
      }
      const now = new Date().toISOString();
      const ticket: Ticket = {
        ...input,
        id: crypto.randomUUID(),
        createdAt: now,
        history: [{ at: now, text: '問い合わせを追加' }],
      };
      setWorkspace((w) => ({ ...w, tickets: [ticket, ...w.tickets] }));
      setSelectedId(ticket.id);
      setFilter('all');
      setQuery('');
      setCategoryFilter('all');
      notify('問い合わせを追加しました。');
    }
    setDialog(null);
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('JSONファイルは2MB以下にしてください。');
      const incoming = parseWorkspace(JSON.parse(await file.text()));
      const known = new Set(tickets.map((t) => t.id));
      const additions = incoming.tickets.filter((t) => !known.has(t.id));
      if (tickets.length + additions.length > 200)
        throw new Error('読み込み後の件数が上限の200件を超えます。');
      setWorkspace((w) => ({ ...w, tickets: [...additions, ...w.tickets] }));
      notify(
        `${additions.length}件を読み込みました。重複するIDの${incoming.tickets.length - additions.length}件はスキップしました。`,
      );
    } catch (error) {
      notify(
        error instanceof Error && !('issues' in error) && !(error instanceof SyntaxError)
          ? error.message
          : 'Jev Inbox形式のJSONを読み込めませんでした。現在のデータは変更していません。',
        'error',
      );
    }
    if (importRef.current) importRef.current.value = '';
  }
  function exportJson() {
    downloadFile(
      `jev-inbox-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(workspace, null, 2),
      'application/json',
    );
    notify('JSONを書き出しました。');
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          aria-label="Jev Inbox 受信トレイ"
          onClick={(e) => {
            e.preventDefault();
            changeFilter('all');
          }}
        >
          <Logo />
          <span>
            jev<span className="brand-light"> inbox</span>
            <small>DECISIONS, MADE CLEAR.</small>
          </span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">J</span>
          <span>
            <strong>マイワークスペース</strong>
            <small>Personal workspace</small>
          </span>
          <ChevronDown size={14} />
        </div>
        <span className="nav-caption">WORKSPACE</span>
        <nav aria-label="メインナビゲーション">
          {(['all', 'new', 'review', 'ready', 'resolved'] as Filter[]).map((item) => {
            const Icon =
              item === 'all'
                ? Inbox
                : item === 'new'
                  ? Layers3
                  : item === 'review'
                    ? ShieldCheck
                    : item === 'ready'
                      ? Clock3
                      : CheckCheck;
            return (
              <button
                key={item}
                className={`nav-item ${filter === item ? 'active' : ''}`}
                onClick={() => changeFilter(item)}
                aria-label={filterLabels[item]}
                title={filterLabels[item]}
                aria-current={filter === item ? 'page' : undefined}
              >
                <Icon size={18} />
                <span>{filterLabels[item]}</span>
                <span className="nav-count">{counts[item]}</span>
              </button>
            );
          })}
        </nav>
        <div className="nav-divider" />
        <button
          className="nav-item"
          aria-label="ルールと接続"
          title="ルールと接続"
          onClick={() => setDialog('settings')}
          disabled={busy}
        >
          <Settings2 size={18} />
          <span>ルールと接続</span>
        </button>
        <button
          className="nav-item"
          aria-label="使い方"
          title="使い方"
          onClick={() => setDialog('help')}
        >
          <CircleHelp size={18} />
          <span>使い方</span>
          <ArrowUpRight size={14} />
        </button>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="tiny-spark">
              <Sparkles size={17} />
            </span>
            <strong>
              判断はJevに。
              <br />
              最終確認は、あなたに。
            </strong>
            <p>
              確信度を見ながら、
              <br />
              問い合わせを次の一歩へ。
            </p>
            <button onClick={() => setDialog('help')}>
              Jevの仕組みを知る <ArrowRight size={13} />
            </button>
          </div>
          <div className="local-user">
            <span className="user-avatar">ME</span>
            <span>
              <strong>ローカルワークスペース</strong>
              <small>
                <i className="online-dot" /> このブラウザに保存
              </small>
            </span>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>ワークスペース</span>
            <span>/</span>
            <strong>{filterLabels[filter]}</strong>
          </div>
          <div className="topbar-actions">
            <span className="local-label">
              <ShieldCheck size={14} /> Local first
            </span>
            <button
              className={`mode-chip ${mode}`}
              onClick={() => setDialog('settings')}
              disabled={busy}
            >
              <i />
              {mode === 'demo' ? 'デモモード' : 'Jev 接続モード'}
              <ChevronDown size={12} />
            </button>
            <span className="top-avatar">ME</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">A LITTLE ORDER. A LOT MORE CLARITY.</div>
              <h1>
                {filterLabels[filter]}
                <span className="heading-dot" />
              </h1>
              <p>届いた声を整理して、大切な対応に集中しましょう。</p>
            </div>
            <button
              className="button primary"
              onClick={() => setDialog('new')}
              disabled={busy || storageBlocked}
            >
              <Plus size={17} />
              問い合わせを追加
            </button>
          </div>
          {storageError && (
            <div className="alert error">
              <TriangleAlert size={17} />
              <span>{storageError}</span>
              <button onClick={exportJson}>JSONを書き出す</button>
            </div>
          )}
          {apiOnline === false && (
            <div className="alert error">
              <TriangleAlert size={17} />
              <span>
                仕分けサーバーに接続できません。npm run dev または npm start で起動してください。
              </span>
            </div>
          )}
          <div className="stats-grid">
            <Stat
              label="すべての問い合わせ"
              count={counts.all}
              icon={<Inbox size={18} />}
              note="届いた声を、ひとつの場所に"
              onClick={() => changeFilter('all')}
            />
            <Stat
              label="未仕分け"
              count={counts.new}
              icon={<Layers3 size={18} />}
              note="Jevの仕分けを待っています"
              onClick={() => changeFilter('new')}
            />
            <Stat
              label="人の確認が必要"
              count={counts.review}
              icon={<ShieldCheck size={18} />}
              note="確信度や緊急度をチェック"
              accent="amber"
              onClick={() => changeFilter('review')}
            />
            <Stat
              label="対応済み"
              count={counts.resolved}
              icon={<CheckCheck size={18} />}
              note="ひとつずつ、着実に"
              accent="green"
              onClick={() => changeFilter('resolved')}
            />
          </div>
          <section className={`mode-banner ${mode}`}>
            <span className="banner-icon">
              <Sparkles size={21} />
            </span>
            <div>
              <strong>
                {mode === 'demo'
                  ? 'まずは、仕分けの流れを体験。'
                  : 'Jevが、問い合わせの次の一歩を提案します。'}
              </strong>
              <p>
                {mode === 'demo'
                  ? 'サンプルは架空の問い合わせです。デモの判定はローカルのルールで再現しています。'
                  : '仕分け時に件名・本文・チャネルをTypeSafeへ送信します。判定は自動返信を行いません。'}
              </p>
            </div>
            <button
              onClick={() => setDialog(mode === 'demo' ? 'settings' : 'help')}
              disabled={busy}
            >
              {mode === 'demo' ? 'Jevに接続する' : '判定の仕組み'}
              <ArrowUpRight size={15} />
            </button>
          </section>

          <div className="section-heading">
            <div>
              <h2>問い合わせ一覧</h2>
              <span>{visible.length}件</span>
            </div>
            <div className="section-actions">
              <input
                type="file"
                accept="application/json,.json"
                ref={importRef}
                className="sr-only"
                onChange={(e) => void importFile(e.target.files?.[0])}
                aria-label="JSONファイルを選択"
                disabled={busy || storageBlocked}
              />
              <button
                className="text-button"
                onClick={() => importRef.current?.click()}
                disabled={busy || storageBlocked}
              >
                <Upload size={15} />
                読み込み
              </button>
              <button className="text-button" onClick={() => setDialog('export')}>
                <Download size={15} />
                書き出し
              </button>
            </div>
          </div>
          <div className="inbox-layout">
            <section className="inbox-panel" aria-label="問い合わせ一覧">
              <div className="list-toolbar">
                <label className="search">
                  <Search size={16} />
                  <input
                    placeholder="件名・差出人・本文を検索"
                    aria-label="問い合わせを検索"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      className="icon-button small"
                      onClick={() => setQuery('')}
                      aria-label="検索をクリア"
                    >
                      <X size={13} />
                    </button>
                  )}
                </label>
                <label className="sort-select">
                  <span className="sr-only">並び順</span>
                  <select value={sort} onChange={(e) => setSort(e.target.value)}>
                    <option value="newest">新着順</option>
                    <option value="priority">優先度順</option>
                  </select>
                  <ChevronDown size={13} />
                </label>
              </div>
              <div className="list-controls">
                <div className="filter-tabs" role="group" aria-label="ステータス絞り込み">
                  {(['all', 'new', 'review'] as Filter[]).map((item) => (
                    <button
                      key={item}
                      className={filter === item ? 'active' : ''}
                      onClick={() => changeFilter(item)}
                      aria-pressed={filter === item}
                    >
                      {item === 'all' ? 'すべて' : filterLabels[item]}
                      <span>{counts[item]}</span>
                    </button>
                  ))}
                </div>
                <label className="category-filter">
                  <ListFilter size={14} />
                  <span className="sr-only">分類で絞り込み</span>
                  <select
                    aria-label="分類で絞り込み"
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                  >
                    <option value="all">すべての分類</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {categoryLabels[c]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="table-head">
                <span>問い合わせ</span>
                <span>優先度</span>
                <span>ステータス</span>
              </div>
              <div className="ticket-list">
                {visible.map((ticket, index) => (
                  <button
                    key={ticket.id}
                    className={`ticket-row ${selectedId === ticket.id ? 'selected' : ''}`}
                    onClick={() => setSelectedId(ticket.id)}
                    aria-label={`${ticket.subject}、${ticket.sender}`}
                    aria-pressed={selectedId === ticket.id}
                  >
                    <span className={`ticket-avatar avatar-${index % 5}`}>
                      {ticket.sender.slice(0, 1)}
                    </span>
                    <span className="ticket-summary">
                      <span className="ticket-meta">
                        <strong>{ticket.sender}</strong>
                        <span className="channel">
                          <ChannelIcon channel={ticket.channel} />
                          {ticket.channel}
                        </span>
                        <time>{formatDate(ticket.createdAt)}</time>
                      </span>
                      <strong className="ticket-subject">{ticket.subject}</strong>
                      <span className="ticket-preview">{ticket.body}</span>
                      <span className="ticket-tags">
                        {getCategory(ticket) && (
                          <span className="category-tag">
                            {categoryLabels[getCategory(ticket)!]}
                          </span>
                        )}
                        {ticket.decision && <SourceBadge decision={ticket.decision} />}
                        {ticket.review && (
                          <span className="human-tag">
                            <Check size={10} />
                            確認済み
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="row-priority">
                      <PriorityBadge priority={getPriority(ticket)} />
                    </span>
                    <span className="row-stage">
                      {busyIds.includes(ticket.id) ? (
                        <LoaderCircle className="spin" size={18} />
                      ) : (
                        <StageBadge stage={getStage(ticket, threshold)} />
                      )}
                    </span>
                  </button>
                ))}
                {!visible.length && (
                  <div className="empty-state">
                    <div>
                      <Inbox size={29} />
                    </div>
                    <h3>
                      {tickets.length
                        ? '該当する問い合わせはありません'
                        : '最初の問い合わせを追加しましょう'}
                    </h3>
                    <p>
                      {tickets.length
                        ? '検索語や絞り込み条件を変えてみてください。'
                        : '問い合わせを追加するか、設定からサンプルを読み込めます。'}
                    </p>
                    <button
                      className="button secondary"
                      onClick={() => {
                        if (!tickets.length) setDialog('new');
                        else {
                          setFilter('all');
                          setQuery('');
                          setCategoryFilter('all');
                        }
                      }}
                      disabled={storageBlocked}
                    >
                      {tickets.length ? '絞り込みを解除' : '問い合わせを追加'}
                    </button>
                  </div>
                )}
              </div>
              <div className="list-footer">
                <span>
                  {visible.length} / {tickets.length}件を表示
                </span>
                {progress ? (
                  <div className="progress-inline">
                    <LoaderCircle className="spin" size={14} />
                    {progress.current} / {progress.total}件
                    <button onClick={() => abortRef.current?.abort()}>中止</button>
                  </div>
                ) : (
                  <button
                    className="button compact primary"
                    disabled={busy || !counts.new || storageBlocked}
                    onClick={() =>
                      void evaluate(
                        tickets.filter((t) => getStage(t, threshold) === 'new').slice(0, 20),
                      )
                    }
                  >
                    <Sparkles size={14} />
                    未仕分けを一括仕分け{counts.new > 20 ? '（20件）' : ''}
                  </button>
                )}
              </div>
            </section>
            {selected ? (
              <TicketDetail
                key={selected.id}
                ticket={selected}
                threshold={threshold}
                busy={busy}
                mode={mode}
                onClose={() => setSelectedId(null)}
                onEvaluate={() => void evaluate([selected])}
                onEdit={() => setDialog('edit')}
                onDelete={() => setDialog('delete')}
                onReview={(review) => {
                  updateTicket(selected.id, (t) =>
                    withHistory(
                      { ...t, review: { ...review, reviewedAt: new Date().toISOString() } },
                      `人が確認：${categoryLabels[review.category]} / 優先度 ${priorityLabels[review.priority]}`,
                    ),
                  );
                  notify('確認結果を保存しました。');
                }}
                onResolve={() => {
                  updateTicket(selected.id, (t) =>
                    withHistory(
                      { ...t, resolvedAt: t.resolvedAt ? undefined : new Date().toISOString() },
                      t.resolvedAt ? '対応済みを取り消し' : '対応済みに変更',
                    ),
                  );
                  notify(
                    selected.resolvedAt ? '問い合わせを再開しました。' : '対応済みにしました。',
                  );
                }}
              />
            ) : (
              <aside className="detail-placeholder">
                <div className="placeholder-art">
                  <div />
                  <div />
                  <Inbox size={33} />
                </div>
                <h3>ひとつの声から、次の一歩へ。</h3>
                <p>
                  問い合わせを選択すると、内容と
                  <br />
                  Jevの仕分け結果を確認できます。
                </p>
                <span>
                  <ShieldCheck size={14} /> 最終判断は、いつもあなたの手で。
                </span>
              </aside>
            )}
          </div>
          <footer className="page-footer">
            <span>
              <span className="footer-logo">j.</span>Powered by TypeSafe AI Jev
            </span>
            <span>
              自動返信なし · このブラウザに保存 ·{' '}
              <button onClick={() => setDialog('help')}>データについて</button>
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'success' ? <Check size={18} /> : <TriangleAlert size={18} />}
          <span>{notice.text}</span>
          <button
            className="icon-button small"
            onClick={() => setNotice(null)}
            aria-label="通知を閉じる"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {(dialog === 'new' || dialog === 'edit') && (
        <TicketForm
          initial={dialog === 'edit' ? selected : undefined}
          onSave={saveTicket}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'settings' && (
        <Settings
          threshold={threshold}
          mode={mode}
          apiKey={apiKey}
          serverKey={serverKey}
          onClose={() => setDialog(null)}
          onSave={(settings) => {
            setWorkspace((w) => ({ ...w, threshold: settings.threshold }));
            setMode(settings.mode);
            setApiKey(settings.key);
            setDialog(null);
            notify('設定を保存しました。');
          }}
          onReset={() => setDialog('reset')}
          onRawBackup={() => {
            try {
              downloadFile(
                'jev-inbox-raw-backup.json',
                localStorage.getItem(STORAGE_KEY) ?? '{}',
                'application/json',
              );
            } catch {
              notify('保存領域にアクセスできません。', 'error');
            }
          }}
        />
      )}
      {dialog === 'help' && (
        <Modal title="Jev Inboxの使い方" onClose={() => setDialog(null)}>
          <div className="modal-body help-content">
            <p className="modal-lead">問い合わせを、次の一歩へ。</p>
            <ol>
              <li>
                <strong>声を集める</strong>
                <p>
                  問い合わせを追加するか、Jev
                  Inbox形式のJSONを読み込みます。最初の8件はすべて架空のサンプルです。
                </p>
              </li>
              <li>
                <strong>Jevに仕分けを任せる</strong>
                <p>
                  分類（Choice）、緊急度0〜3（Score）、返信が必要な確率（Noul）を判定します。デモではルールで再現し、TypeSafeへの通信はありません。
                </p>
              </li>
              <li>
                <strong>確信度を見て、確認する</strong>
                <p>
                  分類または緊急度の確信度が基準未満、分類が「その他」、緊急度2.5以上、返信確率が35%超〜65%未満なら要確認に。人が修正・確定できます。
                </p>
              </li>
              <li>
                <strong>対応したら、完了に</strong>
                <p>
                  このアプリは仕分けと記録を行います。返信の送信や外部システムへの割り当ては行いません。
                </p>
              </li>
            </ol>
            <div className="info-box">
              <strong>データはどこに保存されますか？</strong>
              <p>
                問い合わせはこのブラウザのlocalStorageに保存されます。APIキーは画面のメモリだけに保持し、再読み込みで消えます。実接続時は件名・本文・チャネルをローカルサーバー経由でTypeSafeへ送ります。本文に含まれる個人情報も送信対象です。差出人欄は送りません。
              </p>
              <p>
                ブラウザのデータ削除で記録も消えます。定期的にJSONを書き出してください。共有PCでは利用者間で保存データが見える場合があります。
              </p>
            </div>
            <p className="muted">
              確信度はモデルの指標であり、正しさの保証ではありません。日本語での精度は実運用データで評価してください。
            </p>
            <a
              className="external-link"
              href="https://docs.typesafe.ai/introduction"
              target="_blank"
              rel="noreferrer"
            >
              TypeSafeの公式ドキュメント
              <ArrowUpRight size={14} />
            </a>
          </div>
        </Modal>
      )}
      {dialog === 'export' && (
        <Modal title="データを書き出す" onClose={() => setDialog(null)}>
          <div className="modal-body">
            <p className="modal-lead">すべての問い合わせ {tickets.length}件を書き出します。</p>
            <button
              className="export-option"
              onClick={() => {
                exportJson();
                setDialog(null);
              }}
            >
              <FileJson size={25} />
              <span>
                <strong>JSONでバックアップ</strong>
                <small>問い合わせ・判定・履歴・確信度の基準を保存。再読み込みできます。</small>
              </span>
              <ArrowDownToLine size={18} />
            </button>
            <button
              className="export-option"
              onClick={() => {
                downloadFile('jev-inbox.csv', toCsv(tickets, threshold), 'text/csv;charset=utf-8');
                setDialog(null);
                notify('CSVを書き出しました。');
              }}
            >
              <Layers3 size={25} />
              <span>
                <strong>CSVで一覧を保存</strong>
                <small>
                  Excelなどで分析するための一覧。アプリへの再読み込みはJSONを使用します。
                </small>
              </span>
              <ArrowDownToLine size={18} />
            </button>
            <p className="muted">
              APIキーは書き出されません。書き出すファイルには問い合わせ本文が含まれます。
            </p>
          </div>
        </Modal>
      )}
      {dialog === 'reset' && (
        <Modal title="サンプルで初期化" onClose={() => setDialog(null)}>
          <div className="modal-body">
            <p>
              現在の{tickets.length}
              件の問い合わせと履歴を、8件の架空サンプルに置き換えます。必要なデータを先に書き出してください。
            </p>
            <div className="modal-actions">
              <button className="button secondary" onClick={exportJson}>
                JSONを書き出す
              </button>
              <button
                className="button danger"
                onClick={() => {
                  const fresh = freshWorkspace();
                  setWorkspace(fresh);
                  setStorageBlocked(false);
                  setSelectedId(fresh.tickets[0].id);
                  setFilter('all');
                  setQuery('');
                  setCategoryFilter('all');
                  setMode('demo');
                  setDialog(null);
                  notify('サンプルを読み込みました。');
                }}
              >
                初期化する
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === 'delete' && selected && (
        <Modal title="問い合わせを削除" onClose={() => setDialog(null)}>
          <div className="modal-body">
            <p>「{selected.subject}」とその履歴を削除します。この操作は元に戻せません。</p>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setDialog(null)}>
                キャンセル
              </button>
              <button
                className="button danger"
                onClick={() => {
                  setWorkspace((w) => ({
                    ...w,
                    tickets: w.tickets.filter((t) => t.id !== selected.id),
                  }));
                  setSelectedId(null);
                  setDialog(null);
                  notify('問い合わせを削除しました。');
                }}
              >
                削除する
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Stat({
  label,
  count,
  icon,
  note,
  accent = '',
  onClick,
}: {
  label: string;
  count: number;
  icon: React.ReactNode;
  note: string;
  accent?: string;
  onClick: () => void;
}) {
  return (
    <button className={`stat-card ${accent}`} onClick={onClick}>
      <span className="stat-label">
        {label}
        <span className="stat-icon">{icon}</span>
      </span>
      <span className="stat-value">
        {String(count).padStart(2, '0')}
        <small>件</small>
      </span>
      <span className="stat-note">{note}</span>
    </button>
  );
}

function TicketForm({
  initial,
  onSave,
  onClose,
}: {
  initial?: Ticket;
  onSave: (input: TicketInput) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState<TicketInput>(
    initial
      ? {
          subject: initial.subject,
          sender: initial.sender,
          channel: initial.channel,
          body: initial.body,
        }
      : { subject: '', sender: '', channel: 'メール', body: '' },
  );
  const [error, setError] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = ticketInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    onSave(parsed.data);
  }
  return (
    <Modal title={initial ? '問い合わせを編集' : '新しい問い合わせ'} onClose={onClose} wide>
      <form className="modal-body form" onSubmit={submit}>
        <p className="modal-lead">届いた声を、そのまま貼り付けてください。</p>
        <div className="form-row">
          <label>
            差出人
            <input
              autoFocus
              required
              maxLength={80}
              value={input.sender}
              placeholder="例：山田 美咲"
              onChange={(e) => setInput({ ...input, sender: e.target.value })}
            />
          </label>
          <label>
            チャネル
            <select
              value={input.channel}
              onChange={(e) =>
                setInput({ ...input, channel: e.target.value as TicketInput['channel'] })
              }
            >
              {channels.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          件名
          <input
            required
            maxLength={160}
            value={input.subject}
            placeholder="例：パスワードの再設定メールが届かない"
            onChange={(e) => setInput({ ...input, subject: e.target.value })}
          />
        </label>
        <label>
          本文
          <textarea
            aria-label="本文"
            required
            rows={7}
            maxLength={6000}
            value={input.body}
            placeholder="問い合わせの内容を入力…"
            onChange={(e) => setInput({ ...input, body: e.target.value })}
          />
          <span className="char-count">{input.body.length.toLocaleString()} / 6,000</span>
        </label>
        {initial && (
          <p className="inline-warning">
            編集すると既存の判定・確認・対応済み状態をリセットします。
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            キャンセル
          </button>
          <button className="button primary" type="submit">
            <MailPlus size={16} />
            {initial ? '更新する' : '追加する'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Settings({
  threshold,
  mode,
  apiKey,
  serverKey,
  onSave,
  onClose,
  onReset,
  onRawBackup,
}: {
  threshold: number;
  mode: 'demo' | 'live';
  apiKey: string;
  serverKey: boolean;
  onSave: (s: { threshold: number; mode: 'demo' | 'live'; key: string }) => void;
  onClose: () => void;
  onReset: () => void;
  onRawBackup: () => void;
}) {
  const [value, setValue] = useState(threshold);
  const [selectedMode, setSelectedMode] = useState(mode);
  const [key, setKey] = useState(apiKey);
  const [error, setError] = useState('');
  return (
    <Modal title="ルールと接続" onClose={onClose}>
      <form
        className="modal-body form"
        onSubmit={(e) => {
          e.preventDefault();
          if (selectedMode === 'live' && !key.trim() && !serverKey) {
            setError('実接続にはTypeSafe APIキーが必要です。');
            return;
          }
          if (key.trim() && !/^[\x21-\x7e]{1,512}$/.test(key.trim())) {
            setError('APIキーは半角英数字・記号で入力してください。');
            return;
          }
          onSave({ threshold: value, mode: selectedMode, key: key.trim() });
        }}
      >
        <section className="settings-section">
          <h3>判定モード</h3>
          <div className="mode-options">
            <label className={selectedMode === 'demo' ? 'selected' : ''}>
              <input
                type="radio"
                name="mode"
                checked={selectedMode === 'demo'}
                onChange={() => setSelectedMode('demo')}
              />
              <span>
                <strong>デモ</strong>
                <small>キー不要・外部送信なし</small>
              </span>
              <Sparkles size={18} />
            </label>
            <label className={selectedMode === 'live' ? 'selected' : ''}>
              <input
                type="radio"
                name="mode"
                checked={selectedMode === 'live'}
                onChange={() => setSelectedMode('live')}
              />
              <span>
                <strong>Jevに接続</strong>
                <small>TypeSafe APIを利用</small>
              </span>
              <Zap size={18} />
            </label>
          </div>
          <label>
            TypeSafe APIキー
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
              value={key}
              placeholder={serverKey ? 'サーバーのキーを利用できます' : 'APIキーを入力'}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <small className="hint">
            キーはこの画面を開いている間だけ保持します。再読み込みで消え、書き出しにも含まれません。
            {serverKey && ' サーバーの環境変数にもキーが設定されています。'}
          </small>
          {key && (
            <button type="button" className="text-button" onClick={() => setKey('')}>
              入力したキーを消去
            </button>
          )}
          <p className="hint">
            実接続では、仕分けする件名・本文・チャネルをTypeSafeに送信します。TypeSafeのAPI利用料金が適用されます。モード変更だけでは送信しません。
          </p>
          <a
            className="external-link"
            href="https://console.typesafe.ai"
            target="_blank"
            rel="noreferrer"
          >
            TypeSafeでAPIキーを取得
            <ArrowUpRight size={13} />
          </a>
        </section>
        <section className="settings-section">
          <h3>
            人に確認を回す基準<span className="threshold-value">{Math.round(value * 100)}%</span>
          </h3>
          <label className="range-label">
            <span className="sr-only">確信度の基準</span>
            <input
              aria-label="確信度の基準"
              type="range"
              min="50"
              max="99"
              value={Math.round(value * 100)}
              onChange={(e) => setValue(Number(e.target.value) / 100)}
            />
          </label>
          <div className="range-ends">
            <span>50% · 確認を少なく</span>
            <span>99% · 慎重に確認</span>
          </div>
          <p className="hint">
            分類または緊急度の確信度がこの値を下回ると「要確認」に。緊急案件・その他・返信判断が曖昧なものは必ず確認に回します。保存済みの未確認判定にも反映されます。
          </p>
        </section>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            キャンセル
          </button>
          <button className="button primary" type="submit">
            設定を保存
          </button>
        </div>
        <div className="settings-data">
          <strong>データの管理</strong>
          <button type="button" className="text-button" onClick={onRawBackup}>
            保存領域をそのまま書き出す
          </button>
          <button type="button" className="text-button danger-text" onClick={onReset}>
            サンプルで初期化
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TicketDetail({
  ticket,
  threshold,
  busy,
  mode,
  onClose,
  onEvaluate,
  onEdit,
  onDelete,
  onReview,
  onResolve,
}: {
  ticket: Ticket;
  threshold: number;
  busy: boolean;
  mode: 'demo' | 'live';
  onClose: () => void;
  onEvaluate: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReview: (r: { category: Category; priority: Priority; needsReply: boolean }) => void;
  onResolve: () => void;
}) {
  const d = ticket.decision;
  const [reviewing, setReviewing] = useState(false);
  const [category, setCategory] = useState<Category>(getCategory(ticket) ?? 'other');
  const [priority, setPriority] = useState<Priority>(getPriority(ticket) ?? 'normal');
  const [needsReply, setNeedsReply] = useState(
    ticket.review?.needsReply ?? (d ? d.needsReply >= 0.65 : true),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const reviewRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (reviewing) reviewRef.current?.scrollIntoView({ block: 'nearest' });
  }, [reviewing]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);
  const stage = getStage(ticket, threshold);
  const reasons = d ? reviewReasons(d, threshold) : [];
  function startReview() {
    setCategory(getCategory(ticket) ?? 'other');
    setPriority(getPriority(ticket) ?? 'normal');
    setNeedsReply(ticket.review?.needsReply ?? (d ? d.needsReply >= 0.65 : true));
    setReviewing(true);
  }
  return (
    <aside className="detail-panel" aria-label="問い合わせの詳細">
      <div className="detail-header">
        <span>
          <span className="live-dot" />
          問い合わせの詳細
        </span>
        <div>
          <button className="icon-button mobile-back" onClick={onClose} aria-label="一覧に戻る">
            <ArrowLeft size={18} />
          </button>
          <div className="menu-wrapper">
            <button
              className="icon-button"
              aria-label="問い合わせの操作"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
              disabled={busy}
            >
              <MoreHorizontal size={19} />
            </button>
            {menuOpen && (
              <div className="dropdown-menu">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit();
                  }}
                >
                  <Pencil size={14} />
                  内容を編集
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                  className="danger-text"
                >
                  <Trash2 size={14} />
                  削除
                </button>
              </div>
            )}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="詳細を閉じる">
            <X size={17} />
          </button>
        </div>
      </div>
      <div className="detail-content">
        <div className="detail-status">
          <StageBadge stage={stage} />
          <span className="ticket-id">
            #{ticket.id.startsWith('sample-') ? `00${ticket.id.slice(-1)}` : ticket.id.slice(0, 6)}
          </span>
        </div>
        <h2>{ticket.subject}</h2>
        <div className="sender-line">
          <span className="sender-avatar">{ticket.sender.slice(0, 1)}</span>
          <div>
            <strong>{ticket.sender}</strong>
            <small>
              {ticket.channel} · {formatDate(ticket.createdAt, true)}
            </small>
          </div>
        </div>
        <p className="message-body">{ticket.body}</p>
        <div className="decision-section">
          <div className="decision-heading">
            <h3>
              <Sparkles size={16} />
              仕分けインサイト
            </h3>
            {d && <SourceBadge decision={d} />}
          </div>
          {!d && ticket.review ? (
            <div className="confirmed-note">
              <CheckCheck size={17} />
              <div>
                <strong>人が仕分けを確定しました。</strong>
                <span>
                  {categoryLabels[ticket.review.category]} · 優先度{' '}
                  {priorityLabels[ticket.review.priority]}
                  <br />
                  {ticket.review.needsReply ? '返信が必要' : '返信は不要'}
                  <br />
                  担当：{categoryTeams[ticket.review.category]}
                </span>
              </div>
            </div>
          ) : !d ? (
            <div className="no-decision">
              <span>
                <Sparkles size={27} />
              </span>
              <strong>この声は、まだ仕分け前です。</strong>
              <p>
                分類と優先度を提案して、
                <br />
                次のアクションにつなげます。
              </p>
              <button className="button primary" onClick={onEvaluate} disabled={busy}>
                <Sparkles size={15} />
                {mode === 'demo' ? 'デモで仕分ける' : 'Jevで仕分ける'}
              </button>
            </div>
          ) : (
            <>
              <div className="classification">
                <div>
                  <span>分類</span>
                  <strong>{categoryLabels[d.category]}</strong>
                </div>
                <span className="category-glyph">
                  <Layers3 size={20} />
                </span>
              </div>
              <div className="confidence-label">
                <span>分類の確信度</span>
                <strong>
                  {Math.round(d.categoryConfidence * 100)}
                  <small>%</small>
                </strong>
              </div>
              <div className="confidence-track">
                <span
                  style={{ width: `${d.categoryConfidence * 100}%` }}
                  className={d.categoryConfidence < threshold ? 'low' : ''}
                />
                <i style={{ left: `${threshold * 100}%` }} />
              </div>
              <div className="confidence-caption">
                <span>
                  {d.categoryConfidence >= threshold
                    ? '基準を満たしています'
                    : '人による確認が必要です'}
                </span>
                <span>基準 {Math.round(threshold * 100)}%</span>
              </div>
              <div className="insight-grid">
                <div>
                  <span>優先度の提案</span>
                  <PriorityBadge priority={priorityFromScore(d.urgency)} />
                  <small>確信度 {Math.round(d.urgencyConfidence * 100)}%</small>
                </div>
                <div>
                  <span>返信が必要な確率</span>
                  <strong className="reply-value">
                    {Math.round(d.needsReply * 100)}
                    <small>%</small>
                  </strong>
                  <small>Noul · yesの確率</small>
                </div>
              </div>
              {stage === 'review' && (
                <div className="review-note">
                  <ShieldCheck size={17} />
                  <div>
                    <strong>人の確認をお願いします</strong>
                    <ul>
                      {reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {ticket.review && (
                <div className="confirmed-note">
                  <CheckCheck size={17} />
                  <div>
                    <strong>確認済みの判断</strong>
                    <span>
                      {categoryLabels[ticket.review.category]} · 優先度{' '}
                      {priorityLabels[ticket.review.priority]}
                      <br />
                      {ticket.review.needsReply ? '返信が必要' : '返信は不要'}
                    </span>
                  </div>
                </div>
              )}
              <div className="team-route">
                <span>担当チームの提案</span>
                <strong>
                  {categoryTeams[getCategory(ticket)!]}
                  <ArrowUpRight size={13} />
                </strong>
              </div>
              <details className="technical-details">
                <summary>
                  判定の内訳を見る
                  <ChevronDown size={13} />
                </summary>
                <div className="probabilities">
                  {categories.map((c) => (
                    <div key={c}>
                      <span>{categoryLabels[c]}</span>
                      <div>
                        <i style={{ width: `${d.categoryProbabilities[c] * 100}%` }} />
                      </div>
                      <strong>{Math.round(d.categoryProbabilities[c] * 100)}%</strong>
                    </div>
                  ))}
                </div>
                <p>上記は分類の確率分布です。「確信度」とは別の指標です。</p>
                <dl>
                  <div>
                    <dt>緊急度スコア</dt>
                    <dd>{d.urgency.toFixed(2)} / 3</dd>
                  </div>
                  <div>
                    <dt>モデル</dt>
                    <dd>{d.model}</dd>
                  </div>
                  <div>
                    <dt>判定日時</dt>
                    <dd>{formatDate(d.evaluatedAt, true)}</dd>
                  </div>
                  <div>
                    <dt>処理時間</dt>
                    <dd>
                      {d.source === 'demo'
                        ? 'ローカルのルール判定'
                        : `${d.durationMs.toLocaleString()} ms`}
                    </dd>
                  </div>
                  {d.usage && (
                    <div>
                      <dt>利用トークン</dt>
                      <dd>
                        入力 {d.usage.inputTokens} / 出力 {d.usage.outputTokens}
                      </dd>
                    </div>
                  )}
                </dl>
                <button
                  className="text-button"
                  disabled={busy || !!ticket.resolvedAt || !!ticket.review}
                  onClick={onEvaluate}
                >
                  <Sparkles size={13} />
                  {mode === 'demo' ? 'デモで再仕分け' : 'Jevで再仕分け'}
                </button>
                {ticket.review && (
                  <p>再仕分けする場合は、内容の編集で確認済み状態をリセットしてください。</p>
                )}
              </details>
            </>
          )}
        </div>
        {reviewing && (
          <form
            ref={reviewRef}
            className="review-form form"
            onSubmit={(e) => {
              e.preventDefault();
              onReview({ category, priority, needsReply });
              setReviewing(false);
            }}
          >
            <h3>内容を確認して確定</h3>
            <label>
              分類
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabels[c]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              優先度
              <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {priorityLabels[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={needsReply}
                onChange={(e) => setNeedsReply(e.target.checked)}
              />
              返信が必要
            </label>
            <div className="review-actions">
              <button
                type="button"
                className="button secondary compact"
                onClick={() => setReviewing(false)}
              >
                キャンセル
              </button>
              <button type="submit" className="button primary compact" disabled={busy}>
                確認して確定
              </button>
            </div>
          </form>
        )}
        <details className="history">
          <summary>
            アクティビティ<span>{ticket.history.length}</span>
            <ChevronDown size={13} />
          </summary>
          <ol>
            {[...ticket.history].reverse().map((h, i) => (
              <li key={`${h.at}-${i}`}>
                <span>{h.text}</span>
                <time>{formatDate(h.at, true)}</time>
              </li>
            ))}
          </ol>
        </details>
      </div>
      <div className="detail-footer">
        {ticket.resolvedAt ? (
          <button className="button secondary full" onClick={onResolve} disabled={busy}>
            対応済みを取り消す
          </button>
        ) : (
          <>
            <button className="button secondary" onClick={startReview} disabled={busy}>
              <Pencil size={14} />
              {ticket.review ? '確認を修正' : '確認・修正'}
            </button>
            <button
              className="button primary"
              onClick={onResolve}
              disabled={busy || stage === 'review' || stage === 'new'}
              title={
                stage === 'review' || stage === 'new'
                  ? '先に内容を確認して確定してください'
                  : undefined
              }
            >
              <Check size={15} />
              対応済みに
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
