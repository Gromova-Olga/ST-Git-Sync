import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';

const extensionName = 'ST-Git-Sync';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

let sessionToken = null;
let fs = null;
let pfs = null;
let git = null;
let GitHttp = null;

if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = { repoUrl: '', rememberToken: false, persistentToken: '' };
}

function loadLibrary(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) return resolve();
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// --- УТИЛИТЫ ЗАЩИТЫ ---

function setSyncLock(isLocked) {
    const buttons = $('#sync-pull-btn, #sync-push-btn, #sync-save-settings, #sync-hard-reset-btn');
    buttons.prop('disabled', isLocked);
    buttons.css({
        'opacity': isLocked ? '0.5' : '1',
        'cursor': isLocked ? 'not-allowed' : 'pointer'
    });
}

async function validateGitHubToken(token) {
    try {
        $('#sync-log').text('Проверка прав доступа GitHub...').css('color', '#fff');
        const res = await fetch('https://api.github.com/user', {
            headers: { 'Authorization': `token ${token}` }
        });
        if (res.status === 401) throw new Error("Токен недействителен (401). Проверьте правильность токена.");
        if (res.status === 403) throw new Error("Превышен лимит запросов или токен без прав (403).");
        if (!res.ok) throw new Error(`GitHub API ответил ошибкой: ${res.status}`);
        return true;
    } catch (e) {
        toastr.error(e.message);
        $('#sync-log').text('Ошибка авторизации').css('color', '#e74c3c');
        return false;
    }
}

async function initExtension() {
    try {
        await loadLibrary(`${extensionFolderPath}/lightning-fs.min.js`);
        await loadLibrary(`${extensionFolderPath}/isomorphic-git.min.js`);
        await loadLibrary(`${extensionFolderPath}/isomorphic-git-http.min.js`);
    } catch (e) {
        console.error('Не удалось загрузить библиотеки Git!', e);
        return toastr.error('Отсутствуют файлы библиотек');
    }

    fs = new LightningFS('fs');
    pfs = fs.promises;
    git = window.isomorphicGit || window.git;
    GitHttp = window.GitHttp;

    const response = await fetch(`${extensionFolderPath}/example.html`);
    if (!response.ok) return console.error(`Ошибка загрузки HTML: ${response.status}`);

    $('#extensions_settings2').append(await response.text());

    const settings = extension_settings[extensionName];
    $('#sync-repo-url').val(settings.repoUrl);
    $('#sync-remember-token').prop('checked', settings.rememberToken);

    if (settings.rememberToken) {
        $('#sync-token').val(settings.persistentToken);
        updateIndicator(true);
    }

    // --- ОБРАБОТЧИКИ КНОПОК ---

    $('#sync-save-settings').on('click', () => {
        settings.repoUrl = $('#sync-repo-url').val();
        settings.rememberToken = $('#sync-remember-token').prop('checked');
        
        if (settings.rememberToken) {
            settings.persistentToken = $('#sync-token').val();
            sessionToken = null;
        } else {
            sessionToken = $('#sync-token').val();
            settings.persistentToken = '';
        }

        saveSettingsDebounced();
        updateIndicator(!!(sessionToken || settings.persistentToken));
        toastr.success('Настройки сохранены');
    });

    $('#sync-pull-btn').on('click', async () => {
        const token = await getToken();
        if (!token) return;
        if (!(await validateGitHubToken(token))) return;
        executeSyncAction('pull', token);
    });

    $('#sync-push-btn').on('click', async () => {
        const token = await getToken();
        if (!token) return;
        if (!(await validateGitHubToken(token))) return;
        executeSyncAction('push', token);
    });

    $('#sync-hard-reset-btn').on('click', async () => {
        if (!confirm('Это очистит локальную папку Git в браузере. Ваши чаты в Таверне не пострадают. Помогает при ошибках Push/Pull. Продолжить?')) return;
        try {
            window.indexedDB.deleteDatabase('fs');
            toastr.success('Кэш очищен. Страница будет перезагружена.');
            setTimeout(() => location.reload(), 1500);
        } catch (e) { toastr.error('Ошибка при очистке кэша'); }
    });
}

async function getToken() {
    const settings = extension_settings[extensionName];
    if (settings.rememberToken && settings.persistentToken) return settings.persistentToken;
    if (sessionToken) return sessionToken;
    
    const input = await callGenericPopup('Введите GitHub Token для этой сессии:', 'password');
    if (input) {
        sessionToken = input;
        updateIndicator(true);
        return sessionToken;
    }
    toastr.error('Токен не введен');
    return null;
}

function updateIndicator(active) {
    $('#sync-auth-indicator').css('background', active ? '#2ecc71' : '#e74c3c');
    $('#sync-log').text(active ? 'Токен активен' : 'Требуется токен');
}

async function executeSyncAction(action, token) {
    const repoUrl = extension_settings[extensionName].repoUrl;
    const dir = '/sillytavern-sync';
    
    if (!repoUrl) return toastr.error('Введите URL репозитория!');

    setSyncLock(true);
    $('#sync-log').text(`Инициализация ${action}...`).css('color', '#fff');

    const baseHeaders = getRequestHeaders();
    const jsonHeaders = Object.assign({}, baseHeaders, { 'Content-Type': 'application/json' });
    const formHeaders = {};
    for (const [key, value] of Object.entries(baseHeaders)) {
        if (key.toLowerCase() !== 'content-type') formHeaders[key] = value;
    }

    try {
        const hasGit = await pfs.stat(dir + '/.git').catch(() => false);
        
        if (!hasGit) {
            $('#sync-log').text('Клонирование репозитория...');
            await git.clone({
                fs, http: GitHttp, dir,
                url: repoUrl,
                corsProxy: 'https://cors.isomorphic-git.org',
                onAuth: () => ({ username: token }),
                singleBranch: true, depth: 1
            });
        }

        if (action === 'pull') {
            $('#sync-log').text('Загрузка изменений (Pull)...');
            await git.pull({
                fs, http: GitHttp, dir,
                url: repoUrl,
                corsProxy: 'https://cors.isomorphic-git.org',
                onAuth: () => ({ username: token, password: '' }),
                author: { name: 'ST User', email: 'user@st.local' }
            });

            // --- ИМПОРТ ПЕРСОНАЖЕЙ ---
            const charsFile = await pfs.readFile(`${dir}/characters.json`, 'utf8').catch(() => '[]');
            let charsData = JSON.parse(charsFile);
            if (!Array.isArray(charsData)) charsData = Object.values(charsData);

            for (const char of charsData) {
                if (!char.avatar) continue;
                try {
                    const rawData = await pfs.readFile(`${dir}/characters/${char.avatar}`);
                    const uint8Array = rawData instanceof Uint8Array ? rawData : new Uint8Array(Object.values(rawData));
                    
                    const fd = new FormData();
                    fd.append('avatar', new Blob([uint8Array]), char.avatar);
                    fd.append('file_type', char.avatar.endsWith('.webp') ? 'webp' : 'png');

                    await fetch('/api/characters/import', { method: 'POST', headers: formHeaders, body: fd });
                } catch (e) { console.error(`Ошибка импорта персонажа ${char.avatar}`, e); }
            }

            // --- ИМПОРТ МИРОВ ---
            const worldsList = await pfs.readdir(`${dir}/worlds`).catch(() => []);
            for (const file of worldsList) {
                try {
                    const rawData = await pfs.readFile(`${dir}/worlds/${file}`);
                    const fd = new FormData();
                    fd.append('avatar', new Blob([rawData]), file);
                    await fetch('/api/worldinfo/import', { method: 'POST', headers: formHeaders, body: fd });
                } catch (e) { console.error(`Ошибка импорта мира ${file}`, e); }
            }

            // --- ИМПОРТ ЧАТОВ ---
            const charFolders = await pfs.readdir(`${dir}/chats`).catch(() => []);
            for (const charFolderName of charFolders) {
                const charChats = await pfs.readdir(`${dir}/chats/${charFolderName}`).catch(() => []);
                const charInfo = charsData.find(c => c.name === charFolderName);
                const avatarUrl = String(charInfo ? charInfo.avatar : `${charFolderName}.png`);

                for (const chatFile of charChats) {
                    try {
                        const rawData = await pfs.readFile(`${dir}/chats/${charFolderName}/${chatFile}`, 'utf8');
                        const lines = rawData.split('\n').filter(line => line.trim());
                        const chatData = lines.map(line => {
                            try { return JSON.parse(line); } catch(e) { return null; }
                        }).filter(x => x !== null);

                        if (chatData.length === 0) continue;

                        await fetch('/api/chats/save', {
                            method: 'POST', headers: jsonHeaders,
                            body: JSON.stringify({
                                avatar_url: avatarUrl,
                                chat: chatData,
                                file_name: chatFile.replace(/\.jsonl$/i, ''),
                                force: true
                            })
                        });
                    } catch (e) { console.error(`Ошибка импорта чата ${chatFile}`, e); }
                }
            }

            $('#sync-log').text('Готово! Обновите страницу (F5)').css('color', '#4CAF50');
            toastr.success('Синхронизация завершена');

        } else if (action === 'push') {
            $('#sync-log').text('Сбор данных...');
            
            // Персонажи
            const charsReq = await fetch('/api/characters/all', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({}) });
            const charsData = await charsReq.json();
            await pfs.mkdir(`${dir}/characters`).catch(() => {});
            
            for (const char of charsData) {
                if (!char.avatar) continue;
                const avatarReq = await fetch(`/characters/${encodeURIComponent(char.avatar)}`, { headers: baseHeaders });
                if (avatarReq.ok) {
                    await pfs.writeFile(`${dir}/characters/${char.avatar}`, new Uint8Array(await avatarReq.arrayBuffer()));
                    await git.add({ fs, dir, filepath: `characters/${char.avatar}` });
                }
            }
            await pfs.writeFile(`${dir}/characters.json`, JSON.stringify(charsData, null, 2));
            await git.add({ fs, dir, filepath: 'characters.json' });

            // Миры (Логика исправлена)
            await pfs.mkdir(`${dir}/worlds`).catch(() => {});
            $('#world_editor_select option').each(async function() {
                const txt = $(this).text().trim();
                if (txt && !txt.includes('Select') && !txt.includes('No worlds') && !txt.includes('Выберите') && !txt.startsWith('---') && !/^\d+$/.test(txt)) {
                    const wReq = await fetch('/api/worldinfo/get', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: txt }) });
                    if (wReq.ok) {
                        const worldContent = await wReq.json();
                        const safeFileName = txt.toLowerCase().endsWith('.json') ? txt : `${txt}.json`;
                        await pfs.writeFile(`${dir}/worlds/${safeFileName}`, new TextEncoder().encode(JSON.stringify(worldContent, null, 2)));
                        await git.add({ fs, dir, filepath: `worlds/${safeFileName}` });
                    }
                }
            });

            // Чаты
            await pfs.mkdir(`${dir}/chats`).catch(() => {});
            for (const char of charsData) {
                if (!char.avatar) continue;
                const chatsReq = await fetch('/api/characters/chats', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ avatar_url: char.avatar }) });
                if (chatsReq.ok) {
                    const chats = await chatsReq.json();
                    const folderName = char.avatar.replace(/\.(png|webp)$/i, '');
                    await pfs.mkdir(`${dir}/chats/${folderName}`).catch(() => {});
                    
                    for (const chat of chats) {
                        if (!chat.file_name) continue;
                        const cReq = await fetch('/api/chats/get', {
                            method: 'POST', headers: jsonHeaders,
                            body: JSON.stringify({ ch_name: folderName, file_name: chat.file_name.replace(/\.jsonl$/i, ''), avatar_url: char.avatar })
                        });
                        if (cReq.ok) {
                            const chatContent = await cReq.json();
                            const messages = Array.isArray(chatContent) ? chatContent : (chatContent.chat || chatContent.data || []);
                            if (messages.length > 0) {
                                const jsonl = messages.map(m => JSON.stringify(m)).join('\n');
                                const saveName = chat.file_name.endsWith('.jsonl') ? chat.file_name : `${chat.file_name}.jsonl`;
                                await pfs.writeFile(`${dir}/chats/${folderName}/${saveName}`, new TextEncoder().encode(jsonl));
                                await git.add({ fs, dir, filepath: `chats/${folderName}/${saveName}` });
                            }
                        }
                    }
                }
            }

            $('#sync-log').text('Коммит и отправка...');
            await git.commit({
                fs, dir, message: `Auto-sync: ${new Date().toLocaleString()}`,
                author: { name: 'ST User', email: 'user@st.local' }
            });

            await git.push({
                fs, http: GitHttp, dir,
                url: repoUrl.replace('https://', `https://${token}@`),
                corsProxy: 'https://cors.isomorphic-git.org',
                force: true
            });
            $('#sync-log').text('Push успешен!').css('color', '#4CAF50');
            toastr.success('Данные на GitHub!');
        }
    } catch (err) {
        console.error('Git Error:', err);
        toastr.error(`Ошибка: ${err.message}`);
        $('#sync-log').text('Ошибка. См. консоль (F12)').css('color', '#f44336');
    } finally {
        setSyncLock(false);
    }
}

jQuery(initExtension);
