/**
 * Netarium - 利用者管理・パスワード変更
 */

import { apiFetch } from '../core/api-client.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { clearAuthErrors, validateAuthForm, validatePasswordInput } from '../ui/auth-validation.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';

let accountMode = 'users';
let accountBusy = false;

function setAccountBusy(busy) {
    accountBusy = busy;
    getElement('account-overlay')?.querySelectorAll('input, select, button').forEach(control => {
        if (busy) {
            control.dataset.accountWasDisabled = String(control.disabled);
            control.disabled = true;
        } else if ('accountWasDisabled' in control.dataset) {
            control.disabled = control.dataset.accountWasDisabled === 'true';
            delete control.dataset.accountWasDisabled;
        }
    });
}

function hasAccountDraft() {
    const overlay = getElement('account-overlay');
    return Array.from(overlay?.querySelectorAll('input, select') || []).some(input => {
        if (input.matches('.account-user-active')) return input.checked !== (input.dataset.baseline === 'true');
        if (input.matches('.account-user-role')) return input.value !== input.dataset.baseline;
        if (input.id === 'user-create-role') return input.value !== 'viewer';
        return input.value !== '';
    });
}

function hasCreateUserDraft() {
    const form = getElement('user-create-form');
    if (!form) return false;
    return Array.from(form.querySelectorAll('input, select')).some(input => {
        if (input.id === 'user-create-role') return input.value !== 'viewer';
        return input.value !== '';
    });
}

function toggleCreateUserForm(forceOpen = null) {
    const form = getElement('user-create-form');
    const toggleBtn = getElement('user-create-toggle-btn');
    if (!form || !toggleBtn) return;

    const shouldOpen = forceOpen !== null ? forceOpen : form.hidden;
    if (shouldOpen) {
        form.hidden = false;
        toggleBtn.setAttribute('aria-expanded', 'true');
        getElement('user-create-username')?.focus();
    } else {
        if (hasCreateUserDraft() && !window.confirm('未確定の入力を破棄して閉じますか？')) {
            return;
        }
        form.reset();
        clearAuthErrors(form);
        form.hidden = true;
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.focus();
    }
}

function getElement(id) {
    return document.getElementById(id);
}

function setStatus(message, type = '') {
    const status = getElement('account-status');

    if (!status) {
        return;
    }

    status.textContent = message;
    status.className = type === ''
        ? 'account-status'
        : `account-status account-status-${type}`;
}

function showAccountMode(mode) {
    accountMode = mode;

    const userContent = getElement('user-management-content');
    const passwordContent = getElement('password-change-content');
    const title = getElement('account-title');
    const dialog = getElement('account-dialog');

    if (!userContent || !passwordContent || !title) {
        return;
    }

    const users = mode === 'users';
    userContent.hidden = !users;
    passwordContent.hidden = users;
    title.textContent = users ? '利用者管理' : 'パスワード変更';

    if (dialog) {
        dialog.classList.toggle('account-dialog-password', !users);
    }

    setStatus('');
}

export function closeAccountManagement() {
    if (accountBusy || (hasAccountDraft() && !window.confirm('未確定の入力を破棄して閉じますか？'))) return false;
    const form = getElement('user-create-form');
    if (form) {
        form.reset();
        form.hidden = true;
    }
    const toggleBtn = getElement('user-create-toggle-btn');
    if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', 'false');
    }
    getElement('password-change-content')?.reset();
    getElement('account-overlay')?.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
    getElement('account-user-list-body')?.querySelectorAll('.account-user-role, .account-user-active').forEach(input => {
        if (input.type === 'checkbox') input.checked = input.dataset.baseline === 'true';
        else input.value = input.dataset.baseline;
    });
    clearAuthErrors(getElement('account-overlay'));
    const overlay = getElement('account-overlay');

    if (overlay) {
        overlay.hidden = true;
    }

    registerModalClose('account');
}

export async function openUserManagement() {
    if (!requireAdminUiAction()) {
        return;
    }

    const overlay = getElement('account-overlay');

    if (!overlay) {
        return;
    }

    if (overlay.hidden || accountMode !== 'users') {
        getElement('account-user-list-body')?.replaceChildren();
    }

    overlay.hidden = false;
    showAccountMode('users');
    showUserTab('users');
    const form = getElement('user-create-form');
    if (form) {
        form.hidden = true;
    }
    const toggleBtn = getElement('user-create-toggle-btn');
    if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', 'false');
    }
    registerModalOpen('account', overlay, '#user-create-toggle-btn', { onClose: closeAccountManagement });
    await refreshUserList();
}

export function openPasswordChange() {
    const overlay = getElement('account-overlay');

    if (!overlay) {
        return;
    }

    overlay.hidden = false;
    showAccountMode('password');
    registerModalOpen('account', overlay, '#own-current-password', { onClose: closeAccountManagement });
}

export async function refreshUserList() {
    if (!isCurrentUserAdmin() || accountMode !== 'users') {
        return;
    }

    const body = getElement('account-user-list-body');

    if (!body) {
        return;
    }

    const ownsBusy = !accountBusy;
    if (ownsBusy) setAccountBusy(true);

    try {
        const data = await apiFetch('list_users');
        renderUserList(Array.isArray(data.users) ? data.users : []);
        setStatus('');
    } catch (error) {
        if (!body.children.length) body.innerHTML = '<tr><td colspan="5">読み込めませんでした</td></tr>';
        setStatus(error.message, 'error');
    } finally {
        if (ownsBusy) setAccountBusy(false);
    }
}

function renderUserList(users) {
    const body = getElement('account-user-list-body');

    if (!body) {
        return;
    }

    const drafts = new Map(Array.from(body.querySelectorAll('tr[data-user-id]'), row => {
        const role = row.querySelector('.account-user-role');
        const active = row.querySelector('.account-user-active');
        return [row.dataset.userId, {
            role: role.value !== role.dataset.baseline ? role.value : null,
            active: active.checked !== (active.dataset.baseline === 'true') ? active.checked : null,
            password: row.querySelector('.account-reset-password').value
        }];
    }));
    body.replaceChildren();

    const deletedUsers = users.filter(user => user.is_deleted === true);
    users = users.filter(user => user.is_deleted !== true);
    renderDeletedList(deletedUsers);

    if (users.length === 0) {
        body.innerHTML = '<tr><td colspan="5">利用者が登録されていません</td></tr>';
        return;
    }

    users.forEach(user => {
        const row = document.createElement('tr');
        row.dataset.userId = String(user.id);
        row.dataset.username = String(user.username || '');

        const username = document.createElement('td');
        username.textContent = String(user.username || '');
        row.append(username);

        const roleCell = document.createElement('td');
        const role = document.createElement('select');
        role.className = 'account-user-role';
        role.innerHTML = `
            <option value="viewer">viewer</option>
            <option value="admin">admin</option>
        `;
        role.value = user.role === 'admin' ? 'admin' : 'viewer';
        role.dataset.baseline = role.value;
        const draft = drafts.get(String(user.id));
        if (draft?.role !== null && draft?.role !== undefined) role.value = draft.role;
        roleCell.append(role);
        row.append(roleCell);

        const activeCell = document.createElement('td');
        const activeLabel = document.createElement('label');
        activeLabel.className = 'account-active-toggle';
        const active = document.createElement('input');
        active.type = 'checkbox';
        active.className = 'account-user-active';
        active.checked = user.is_active === true;
        active.dataset.baseline = String(active.checked);
        if (draft?.active !== null && draft?.active !== undefined) active.checked = draft.active;
        activeLabel.append(active, document.createTextNode(' 有効'));
        activeCell.append(activeLabel);
        row.append(activeCell);

        const lastLogin = document.createElement('td');
        lastLogin.textContent = user.last_login_at || '未ログイン';
        row.append(lastLogin);

        const actions = document.createElement('td');
        actions.className = 'account-user-actions';
        actions.innerHTML = `
            <div class="account-user-action-row">
                <button type="button" class="btn btn-sm btn-primary" data-account-action="update">適用</button>
                <input
                    type="password"
                    class="account-reset-password"
                    id="account-reset-password-${user.id}"
                    data-auth-kind="password"
                    data-auth-create="true"
                    aria-label="再設定パスワード"
                    placeholder="再設定パスワード"
                    autocomplete="new-password"
                >
                <button type="button" class="btn btn-sm btn-secondary" data-account-action="reset">再設定</button>
                <button type="button" class="btn btn-sm btn-danger btn-secondary" data-account-action="delete">削除</button>
            </div>
            <span id="account-reset-password-${user.id}-error" class="account-field-error" hidden aria-live="polite"></span>
        `;
        if (draft) actions.querySelector('.account-reset-password').value = draft.password;
        actions.querySelector('.account-reset-password').setAttribute('aria-label', `${user.username || ''}の再設定パスワード`);
        actions.querySelector('[data-account-action="delete"]').setAttribute('aria-label', `${user.username || ''}を削除`);
        row.append(actions);
        body.append(row);
        validatePasswordInput(actions.querySelector('.account-reset-password'));
        if (accountBusy) row.querySelectorAll('input, select, button').forEach(control => {
            control.dataset.accountWasDisabled = String(control.disabled);
            control.disabled = true;
        });
    });
}

function renderDeletedList(users) {
    const body = getElement('account-deleted-list-body');
    if (!body) return;
    body.replaceChildren();

    const count = getElement('account-deleted-count');
    if (count) count.textContent = users.length > 0 ? `（${users.length}）` : '';

    if (users.length === 0) {
        body.innerHTML = '<tr><td colspan="4">削除済みの利用者はいません</td></tr>';
        return;
    }

    users.forEach(user => {
        const row = document.createElement('tr');
        row.dataset.userId = String(user.id);
        row.dataset.username = String(user.username || '');

        const name = document.createElement('td');
        name.textContent = String(user.username || '');
        const role = document.createElement('td');
        role.textContent = user.role === 'admin' ? 'admin' : 'viewer';
        const deletedAt = document.createElement('td');
        deletedAt.textContent = String(user.deleted_at || '');
        const actions = document.createElement('td');
        actions.className = 'account-user-actions';
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'btn btn-sm btn-secondary';
        restore.dataset.accountAction = 'restore';
        restore.textContent = '復元';
        restore.setAttribute('aria-label', `${user.username || ''}を復元`);
        actions.append(restore);
        row.append(name, role, deletedAt, actions);
        if (accountBusy) {
            restore.dataset.accountWasDisabled = 'false';
            restore.disabled = true;
        }
        body.append(row);
    });
}

function showUserTab(tab) {
    const deleted = tab === 'deleted';
    getElement('account-user-list-wrap').hidden = deleted;
    getElement('account-deleted-list-wrap').hidden = !deleted;
    document.querySelectorAll('[data-account-tab]').forEach(button => {
        const selected = (button.dataset.accountTab === 'deleted') === deleted;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
    });
}

async function updateUser(row) {
    if (accountBusy) return;
    const id = Number(row.dataset.userId || 0);
    const role = row.querySelector('.account-user-role')?.value || '';
    const isActive = row.querySelector('.account-user-active')?.checked === true;

    try {
        setAccountBusy(true);
        const data = await apiFetch('update_user', {
            method: 'POST',
            body: JSON.stringify({ id, role, is_active: isActive })
        });

        setStatus(data.message || '利用者情報を更新しました', 'success');
        row.querySelector('.account-user-role').dataset.baseline = role;
        row.querySelector('.account-user-active').dataset.baseline = String(isActive);

        if (data.current_user_changed === true) {
            window.location.href = data.session_ended === true
                ? 'login.php'
                : 'index.php';
            return;
        }

        await refreshUserList();
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        setAccountBusy(false);
    }
}

async function resetUserPassword(row) {
    if (accountBusy) return;
    const id = Number(row.dataset.userId || 0);
    const passwordInput = row.querySelector('.account-reset-password');
    const password = passwordInput?.value || '';

    if (!validatePasswordInput(passwordInput, { submit: true })) return;

    if (!window.confirm('対象利用者の既存セッションを失効させます。再設定しますか？')) {
        return;
    }

    try {
        setAccountBusy(true);
        const data = await apiFetch('reset_user_password', {
            method: 'POST',
            body: JSON.stringify({
                id,
                password,
                password_confirm: password
            })
        });

        setStatus(data.message || 'パスワードを再設定しました', 'success');
        passwordInput.value = '';

        if (data.current_user_changed === true) {
            window.location.href = 'login.php';
            return;
        }

        await refreshUserList();
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        setAccountBusy(false);
    }
}

async function deleteUser(row) {
    if (accountBusy) return;
    const id = Number(row.dataset.userId || 0);
    const name = row.dataset.username || '';
    const role = row.querySelector('.account-user-role');
    const active = row.querySelector('.account-user-active');
    const hasDraft = role.value !== role.dataset.baseline || active.checked !== (active.dataset.baseline === 'true');

    const message = `利用者「${name}」を削除しますか？\n\nこの利用者を削除済み一覧へ移動します。ログインできなくなりますが、操作履歴は保持され、後から復元できます。`
        + (hasDraft ? '\n\nこの利用者の未適用の変更は破棄されます。' : '');
    if (!window.confirm(message)) return;

    try {
        setAccountBusy(true);
        const data = await apiFetch('delete_user', {
            method: 'POST',
            body: JSON.stringify({ id })
        });
        await refreshUserList();
        setStatus(data.message || '利用者を削除済み一覧へ移動しました', 'success');
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        setAccountBusy(false);
    }
}

async function restoreUser(row) {
    if (accountBusy) return;
    const id = Number(row.dataset.userId || 0);
    const name = row.dataset.username || '';

    if (!window.confirm(`利用者「${name}」を復元しますか？\n\n復元後は無効状態です。利用再開する場合は有効化してください。`)) return;

    try {
        setAccountBusy(true);
        const data = await apiFetch('restore_user', {
            method: 'POST',
            body: JSON.stringify({ id })
        });
        await refreshUserList();
        showUserTab('users');
        setStatus(data.message || '利用者を復元しました。無効状態のため、利用再開する場合は有効化してください', 'success');
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        setAccountBusy(false);
    }
}

async function submitCreateUser(event) {
    event.preventDefault();
    if (accountBusy) return;

    const usernameEl = getElement('user-create-username');
    const roleEl = getElement('user-create-role');
    const passwordEl = getElement('user-create-password');
    const confirmEl = getElement('user-create-password-confirm');

    if (!usernameEl || !roleEl || !passwordEl || !confirmEl) {
        console.error('[account-modal] 利用者追加フォームのDOM要素が見つかりません');
        return;
    }
    if (!validateAuthForm(getElement('user-create-form'), { submit: true })) return;

    try {
        setAccountBusy(true);
        const data = await apiFetch('create_user', {
            method: 'POST',
            body: JSON.stringify({
                username: usernameEl.value,
                role: roleEl.value,
                password: passwordEl.value,
                password_confirm: confirmEl.value
            })
        });

        const form = getElement('user-create-form');
        form?.reset();
        clearAuthErrors(form);
        if (form) form.hidden = true;
        const toggleBtn = getElement('user-create-toggle-btn');
        if (toggleBtn) {
            toggleBtn.setAttribute('aria-expanded', 'false');
            toggleBtn.focus();
        }

        await refreshUserList();
        setStatus(data.message || '利用者を登録しました', 'success');
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        setAccountBusy(false);
    }
}

async function submitPasswordChange(event) {
    event.preventDefault();
    if (accountBusy) return;
    if (!validateAuthForm(getElement('password-change-content'), { submit: true })) return;

    try {
        setAccountBusy(true);
        await apiFetch('change_own_password', {
            method: 'POST',
            body: JSON.stringify({
                current_password: getElement('own-current-password')?.value || '',
                new_password: getElement('own-new-password')?.value || '',
                new_password_confirm: getElement('own-new-password-confirm')?.value || ''
            })
        });
        getElement('password-change-content')?.reset();

        window.location.href = 'login.php';
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        setAccountBusy(false);
    }
}

export function initializeAccountManagement() {
    getElement('user-create-toggle-btn')?.addEventListener('click', () => toggleCreateUserForm());
    getElement('user-create-cancel-btn')?.addEventListener('click', () => toggleCreateUserForm(false));
    getElement('user-create-form')?.addEventListener('submit', submitCreateUser);
    getElement('password-change-content')?.addEventListener('submit', submitPasswordChange);
    ['user-create-form', 'password-change-content'].forEach(id => {
        getElement(id)?.addEventListener('input', () => validateAuthForm(getElement(id)));
    });
    getElement('account-user-list-body')?.addEventListener('input', event => {
        if (event.target.matches('.account-reset-password')) validatePasswordInput(event.target);
    });

    getElement('account-user-list-body')?.addEventListener('click', event => {
        const button = event.target instanceof Element
            ? event.target.closest('[data-account-action]')
            : null;
        const row = button?.closest('tr');

        if (!button || !row) {
            return;
        }

        if (button.dataset.accountAction === 'update') {
            updateUser(row);
        } else if (button.dataset.accountAction === 'reset') {
            resetUserPassword(row);
        } else if (button.dataset.accountAction === 'delete') {
            deleteUser(row);
        }
    });

    getElement('account-deleted-list-body')?.addEventListener('click', event => {
        const button = event.target instanceof Element
            ? event.target.closest('[data-account-action="restore"]')
            : null;
        const row = button?.closest('tr');
        if (button && row) restoreUser(row);
    });

    const tabs = Array.from(document.querySelectorAll('[data-account-tab]'));
    tabs.forEach(tab => {
        tab.addEventListener('click', () => showUserTab(tab.dataset.accountTab));
        tab.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
            showUserTab(next.dataset.accountTab);
            next.focus();
        });
    });

}
