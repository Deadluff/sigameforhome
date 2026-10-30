/*
 * In-app confirmation. Replaces window.confirm, whose browser chrome ("localhost:5173", OK/Cancel)
 * breaks the studio and cannot name the action. Built on <dialog>, so focus is trapped and Esc
 * cancels without extra code. Only one question is open at a time; a newer one cancels the older.
 */

export interface ConfirmOptions {
  /** The question, e.g. "Stop this game?". */
  title: string;
  /** What happens if the person goes ahead. */
  body?: string;
  /** Verb-first action label, e.g. "Stop game". */
  confirmLabel: string;
  /** Destructive actions get a red button, and focus starts on Cancel. */
  danger?: boolean;
}

let pending: ((ok: boolean) => void) | null = null;
let wired = false;

function wire(dialog: HTMLDialogElement) {
  if (wired) return;
  wired = true;
  // Buttons in the <form method="dialog"> close it with their value; Esc closes it with ''.
  dialog.addEventListener('close', () => {
    const resolve = pending;
    pending = null;
    resolve?.(dialog.returnValue === 'ok');
  });
  // A click on the backdrop (the dialog element itself, outside its panel) counts as Cancel.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close('');
  });
}

/** Asks a yes/no question in the app's own style. Resolves true only when the action is confirmed. */
export function askConfirm({ title, body = '', confirmLabel, danger = false }: ConfirmOptions): Promise<boolean> {
  const dialog = document.getElementById('confirm-dialog') as HTMLDialogElement | null;
  // Very old browsers without <dialog> still get a working question.
  if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n${body}`));
  wire(dialog);
  pending?.(false);
  pending = null;
  if (dialog.open) dialog.close('');

  dialog.querySelector('#confirm-title')!.textContent = title;
  const text = dialog.querySelector<HTMLElement>('#confirm-body')!;
  text.textContent = body;
  text.hidden = !body;
  const ok = dialog.querySelector<HTMLButtonElement>('#confirm-ok')!;
  ok.textContent = confirmLabel;
  ok.className = danger ? 'bad' : 'primary';
  dialog.classList.toggle('danger', danger);

  dialog.returnValue = '';
  dialog.showModal();
  // A destructive step must not run from a stray Enter, so its dialog opens on Cancel.
  (danger ? dialog.querySelector<HTMLButtonElement>('#confirm-cancel')! : ok).focus();
  return new Promise((resolve) => { pending = resolve; });
}
