import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, Inbox, Mail, MessageCircle, FileText } from 'lucide-react';
import {
  type Decision,
  type Priority,
  type Stage,
  priorityLabels,
  stageLabels,
} from '../shared/domain';

export function Logo() {
  return (
    <span className="logo-mark">
      <Inbox size={23} strokeWidth={1.8} />
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="閉じる">
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function PriorityBadge({ priority }: { priority?: Priority }) {
  return priority ? (
    <span className={`priority priority-${priority}`}>
      <i />
      {priorityLabels[priority]}
    </span>
  ) : (
    <span className="muted">—</span>
  );
}
export function StageBadge({ stage }: { stage: Stage }) {
  return (
    <span className={`stage stage-${stage}`}>
      <i />
      {stageLabels[stage]}
    </span>
  );
}
export function SourceBadge({ decision }: { decision: Decision }) {
  return (
    <span className={`source source-${decision.source}`}>
      {decision.source === 'demo' ? 'デモ判定' : 'Jev判定'}
    </span>
  );
}
export function ChannelIcon({ channel }: { channel: string }) {
  return channel === 'メール' ? (
    <Mail size={12} />
  ) : channel === 'チャット' ? (
    <MessageCircle size={12} />
  ) : (
    <FileText size={12} />
  );
}
export function formatDate(value: string, detailed = false) {
  return new Intl.DateTimeFormat(
    'ja-JP',
    detailed
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  ).format(new Date(value));
}
