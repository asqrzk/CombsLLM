// ============================================================
// UI primitives: toast notifications and the confirm modal.
// ============================================================
import {
  toastContainer,
  confirmModal, confirmModalTitle, confirmModalBody,
  confirmModalClose, confirmModalCancel, confirmModalConfirm
} from './dom.js';

const TOAST_ICONS = {
  info: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  success: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  warning: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  error: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>'
};

export function toast(message, type = 'info', duration = 4200) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
    <div class="toast-body"></div>
    <button class="toast-close" aria-label="Dismiss">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>`;
  el.querySelector('.toast-body').textContent = message;
  toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  const dismiss = () => {
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 220);
  };
  const timer = setTimeout(dismiss, duration);
  el.querySelector('.toast-close').addEventListener('click', () => { clearTimeout(timer); dismiss(); });

  while (toastContainer.children.length > 4) toastContainer.firstChild.remove();
}

let confirmModalResolve = null;

export function showConfirmModal({ title = 'Confirm', message = 'Are you sure?', confirmText = 'Delete', onConfirm }) {
  confirmModalTitle.textContent = title;
  confirmModalBody.textContent = message;
  confirmModalConfirm.textContent = confirmText;
  confirmModalResolve = onConfirm;
  confirmModal.classList.remove('hidden');
}

export function hideConfirmModal() {
  confirmModal.classList.add('hidden');
  confirmModalResolve = null;
}

confirmModalClose.addEventListener('click', hideConfirmModal);
confirmModalCancel.addEventListener('click', hideConfirmModal);
confirmModalConfirm.addEventListener('click', () => {
  if (confirmModalResolve) confirmModalResolve();
});
confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal) hideConfirmModal();
});
