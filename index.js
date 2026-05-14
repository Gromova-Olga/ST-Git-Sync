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

// --- КРИПТО: шифрование токена через Web Crypto API ---
// Ключ деривируется из userAgent + origin — токен не хранится в открытом виде.

async function _deriveKey() {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(navigator.userAgent + location.origin),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode('st-git-sync-v1'), iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptToken(token) {
    const enc = new TextEncoder();
    const key = await _deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(token));
    return JSON.stringify({ iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) });
}

async function decryptToken(stored) {
    try {
        const { iv, data } = JSON.parse(stored);
        const key = await _deriveKey();
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(iv) },
            key,
            new Uint8Array(data)
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        console.warn('[ST-Git-Sync] Не удалось расшифровать токен (возможно, сохранён в старом формате):', e.message);
        return null;
    }
}

// --- ВАЛИДАЦИЯ ДАННЫХ ИЗ РЕПОЗИТОРИЯ ---

function validateCharacter(char) {
    if (!char || typeof char !== 'object') return false;
    if (typeof char.avatar !== 'string') return false;
    // Защита от path traversal: запрещаем опасные конструкции, разрешаем Unicode
    if (/[\/\\<>:"|?*\x00]/.test(char.avatar) || char.avatar.includes('..')) {
        console.warn('[ST-Git-Sync] Пропущен персонаж с подозрительным avatar: ' + char.avatar);
        return false;
    }
    if (!/\.(png|webp)$/i.test(char.avatar)) {
        console.warn('[ST-Git-Sync] Пропущен персонаж с подозрительным avatar: ' + char.avatar);
        return false;
    }
    return true;
}

function validateChatMessage(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (typeof msg.name !== 'string') return false;
    if (typeof msg.mes !== 'string') return false;
    return true;
}

function validateWorldFileName(name) {
    // Запрещаем опасные конструкции, разрешаем Unicode, скобки, пробелы
    if (/[\/\\<>:"|?*\x00]/.test(name) || name.includes('..')) {
        console.warn('[ST-Git-Sync] Пропущен файл мира с подозрительным именем: ' + name);
        return false;
    }
    if (!/.json$/i.test(name)) {
        console.warn('[ST-Git-Sync] Пропущен файл мира с подозрительным именем: ' + name);
        return false;
    }
    return true;
}

// --- АВТОРИЗАЦИЯ GITHUB ---

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

// --- ИНИЦИАЛИЗАЦИЯ ---

async function initExtension() {
    try {
        // 1. Загружаем ПРАВИЛЬНЫЙ Buffer
        await loadLibrary(`${extensionFolderPath}/buffer.min.js`);
        
        // Жестко привязываем Buffer, переопределяя любые другие переменные
        if (typeof buffer !== 'undefined' && buffer.Buffer) {
            window.Buffer = buffer.Buffer;
        }

        // 2. Загружаем остальные библиотеки
        await loadLibrary(`${extensionFolderPath}/lightning-fs.min.js`);
        await loadLibrary(`${extensionFolderPath}/isomorphic-git.min.js`);
        await loadLibrary(`${extensionFolderPath}/isomorphic-git-http.min.js`);
    } catch (e) {
        console.error('[ST-Git-Sync] Не удалось загрузить библиотеки Git!', e);
        return toastr.error('Отсутствуют файлы библиотек. Проверьте установку.');
    }

    // Инициализация эмулятора файловой системы
    fs = new LightningFS('fs');
    pfs = fs.promises;

    // Настройка объектов Git и GitHttp
    git = window.isomorphicGit || window.git;
    if (!git && window.isomorphicGit && window.isomorphicGit.default) {
        git = window.isomorphicGit.default;
    }
    GitHttp = window.GitHttp;

    // Железобетонная проверка: всё ли загрузилось правильно?
    if (!git || !GitHttp || !window.Buffer || typeof window.Buffer.isBuffer !== 'function') {
        console.error('[ST-Git-Sync] Ошибка загрузки компонентов!', { git, GitHttp, Buffer: window.Buffer });
        return toastr.error('Критическая ошибка: библиотеки не загрузились. Проверьте консоль (F12).');
    }

    // Загрузка интерфейса настроек
    const response = await fetch(`${extensionFolderPath}/example.html`);
    if (!response.ok) return console.error(`Ошибка загрузки HTML: ${response.status}`);

    $('#extensions_settings2').append(await response.text());

    const settings = extension_settings[extensionName];
    $('#sync-repo-url').val(settings.repoUrl);
    $('#sync-remember-token').prop('checked', settings.rememberToken);

    if (settings.rememberToken && settings.persistentToken) {
        // Дешифровка токена
        const decrypted = await decryptToken(settings.persistentToken);
        if (decrypted) {
            $('#sync-token').val(decrypted);
            updateIndicator(true);
        } else {
            // Поддержка старого формата
            $('#sync-token').val(settings.persistentToken);
            updateIndicator(true);
            toastr.warning('Токен сохранён в устаревшем формате. Пересохраните настройки.');
        }
    }
    // --- ОБРАБОТЧИКИ КНОПОК ---

    $('#sync-save-settings').on('click', async () => {
        settings.repoUrl = $('#sync-repo-url').val();
        settings.rememberToken = $('#sync-remember-token').prop('checked');

        // Предупреждение о публичном репозитории
        const repoUrl = settings.repoUrl.toLowerCase();
        if (repoUrl && !repoUrl.includes('private') && repoUrl.includes('github.com')) {
            const confirmed = confirm(
                '⚠️ Убедитесь, что репозиторий приватный!\n\n' +
                'Туда будут загружены ваши чаты, карточки персонажей и лорбуки. ' +
                'Публичный репозиторий сделает их доступными всем.\n\nПродолжить?'
            );
            if (!confirmed) return;
        }

        const rawToken = $('#sync-token').val();

        if (settings.rememberToken && rawToken) {
            // Шифруем токен перед сохранением
            settings.persistentToken = await encryptToken(rawToken);
            sessionToken = null;
        } else {
            sessionToken = rawToken || null;
            settings.persistentToken = '';
        }

        saveSettingsDebounced();
        updateIndicator(!!(sessionToken || settings.persistentToken));
        toastr.success('Настройки сохранены');
    });

    $('#sync-pull-btn').on('click', async () => {
        // Добавляем предупреждение
        const confirmed = confirm(
            "⚠️ ВНИМАНИЕ!\n\n" +
            "Загрузка данных (Pull) перезапишет ваши локальные карточки и миры версиями из GitHub.\n\n" +
            "Если вы вносили изменения прямо в Таверне, сначала нажмите 'Отправить (Push)', иначе ваши изменения будут потеряны!\n\n" +
            "Вы уверены, что хотите продолжить загрузку?"
        );
        if (!confirmed) return; // Если нажали "Отмена", прерываем процесс

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

    if (settings.rememberToken && settings.persistentToken) {
        const decrypted = await decryptToken(settings.persistentToken);
        // Фоллбэк на нешифрованный токен (старый формат)
        return decrypted || settings.persistentToken;
    }

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

// --- ОСНОВНАЯ ЛОГИКА SYNC ---

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

    // Токен встраивается прямо в URL — единственный надёжный способ через cors-прокси
    if (!token) { toastr.error('Токен пустой, операция отменена'); setSyncLock(false); return; }
    console.log('[ST-Git-Sync] Токен получен, длина:', token.length);
    // Строим https://TOKEN@github.com/... вручную, без URL API
    // (URL API энкодит username по-разному в разных браузерах/движках)
    let authenticatedUrl;
    try {
        const repoClean = repoUrl.trim().replace(/\/+$/, '');
        if (!repoClean.startsWith('https://')) throw new Error('not https');
        const withoutProto = repoClean.slice('https://'.length);
        // убираем возможный старый токен в URL если пользователь вставил его вручную
        const hostAndPath = withoutProto.includes('@') ? withoutProto.split('@').slice(1).join('@') : withoutProto;
        authenticatedUrl = `https://${token}@${hostAndPath}`;
    } catch (e) {
        toastr.error('Некорректный URL репозитория — нужен https://github.com/...');
        setSyncLock(false);
        return;
    }

    try {
        const hasGit = await pfs.stat(dir + '/.git').catch(() => false);

        if (action === 'push') {
            // Всегда пересоздаём локальный репо для push — чтобы не тащить shallow-историю
            // из предыдущего clone, которая ломает packfile через cors-прокси
            if (hasGit) {
                const rmrf = async (p) => {
                    try {
                        const entries = await pfs.readdir(p);
                        for (const e of entries) await rmrf(p + '/' + e);
                        await pfs.rmdir(p);
                    } catch { try { await pfs.unlink(p); } catch {} }
                };
                await rmrf(dir + '/.git');
            }
            await git.init({ fs, dir, defaultBranch: 'main' });
            await git.addRemote({ fs, dir, remote: 'origin', url: authenticatedUrl, force: true });
        } else if (!hasGit) {
            $('#sync-log').text('Клонирование репозитория...');
            await git.clone({
                fs, http: GitHttp, dir,
                url: authenticatedUrl,
                corsProxy: 'https://cors.isomorphic-git.org',
                singleBranch: true, depth: 1
            });
        }

        if (action === 'pull') {
            $('#sync-log').text('Загрузка изменений (Pull)...');
            await git.pull({
                fs, http: GitHttp, dir,
                url: repoUrl,
                corsProxy: 'https://cors.isomorphic-git.org',
                author: { name: 'ST User', email: 'user@st.local' }
            });

            // --- ИМПОРТ ПЕРСОНАЖЕЙ ---
            const charsFile = await pfs.readFile(`${dir}/characters.json`, 'utf8').catch(() => '[]');
            let charsData = JSON.parse(charsFile);
            if (!Array.isArray(charsData)) charsData = Object.values(charsData);

            const validChars = charsData.filter(validateCharacter);
            if (validChars.length !== charsData.length) {
                toastr.warning(`Пропущено ${charsData.length - validChars.length} персонажей с некорректными данными`);
            }

            // НОВОВВЕДЕНИЕ: Получаем список текущих локальных персонажей для умной сверки
            let localChars = [];
            try {
                const localReq = await fetch('/api/characters/all', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({}) });
                if (localReq.ok) localChars = await localReq.json();
            } catch (e) { console.warn("[ST-Git-Sync] Не удалось получить локальных персонажей", e); }

            for (const char of validChars) {
                try {
                    const rawData = await pfs.readFile(`${dir}/characters/${char.avatar}`);
                    const uint8Array = rawData instanceof Uint8Array ? rawData : new Uint8Array(Object.values(rawData));

                    // Ищем локального персонажа с ТАКИМ ЖЕ ИМЕНЕМ (даже если файл называется иначе)
                    const existingChar = localChars.find(c => c.name === char.name);
                    
                    // Если нашли совпадение по имени — удаляем его локальный файл. Иначе пробуем удалить файл с именем из гитхаба.
                    const fileToDelete = existingChar ? existingChar.avatar : char.avatar;

                    // 1. Отправляем запрос на удаление
                    await fetch('/api/characters/delete', {
                        method: 'POST',
                        headers: jsonHeaders,
                        body: JSON.stringify({ avatar_url: fileToDelete })
                    }).catch(() => null);

                    // 2. Искусственная задержка, чтобы ОС точно успела стереть старый файл
                    await new Promise(resolve => setTimeout(resolve, 400));

                    // 3. Загружаем чистую версию
                    const fd = new FormData();
                    fd.append('avatar', new Blob([uint8Array]), char.avatar);
                    fd.append('file_type', char.avatar.endsWith('.webp') ? 'webp' : 'png');

                    await fetch('/api/characters/import', { method: 'POST', headers: formHeaders, body: fd });
                } catch (e) { console.error(`Ошибка импорта персонажа ${char.avatar}`, e); }
            }
            // --- ИМПОРТ МИРОВ ---
            const worldsList = await pfs.readdir(`${dir}/worlds`).catch(() => []);
            for (const file of worldsList.filter(validateWorldFileName)) {
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
                const charInfo = validChars.find(c => c.name === charFolderName);
                const avatarUrl = String(charInfo ? charInfo.avatar : `${charFolderName}.png`);

                for (const chatFile of charChats) {
                    try {
                        const rawData = await pfs.readFile(`${dir}/chats/${charFolderName}/${chatFile}`, 'utf8');
                        const lines = rawData.split('\n').filter(line => line.trim());
                        const chatData = lines.map(line => {
                            try { return JSON.parse(line); } catch (e) { return null; }
                        }).filter(x => x !== null);

                        // Валидация: фильтруем невалидные сообщения
                        const validMessages = chatData.filter(validateChatMessage);

                        if (validMessages.length === 0) continue;

                        await fetch('/api/chats/save', {
                            method: 'POST', headers: jsonHeaders,
                            body: JSON.stringify({
                                avatar_url: avatarUrl,
                                chat: validMessages,
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

            for (const char of charsData.filter(validateCharacter)) {
                const avatarReq = await fetch(`/characters/${encodeURIComponent(char.avatar)}`, { headers: baseHeaders });
                if (avatarReq.ok) {
                    await pfs.writeFile(`${dir}/characters/${char.avatar}`, new Uint8Array(await avatarReq.arrayBuffer()));
                    await git.add({ fs, dir, filepath: `characters/${char.avatar}` });
                }
            }
            await pfs.writeFile(`${dir}/characters.json`, JSON.stringify(charsData, null, 2));
            await git.add({ fs, dir, filepath: 'characters.json' });

            // Миры
            await pfs.mkdir(`${dir}/worlds`).catch(() => {});
            $('#world_editor_select option').each(async function () {
                const txt = $(this).text().trim();
                if (txt && !txt.includes('Select') && !txt.includes('No worlds') && !txt.includes('Выберите') && !txt.startsWith('---') && !/^\d+$/.test(txt)) {
                    const wReq = await fetch('/api/worldinfo/get', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: txt }) });
                    if (wReq.ok) {
                        const worldContent = await wReq.json();
                        const safeFileName = txt.toLowerCase().endsWith('.json') ? txt : `${txt}.json`;
                        if (!validateWorldFileName(safeFileName)) return;
                        await pfs.writeFile(`${dir}/worlds/${safeFileName}`, new TextEncoder().encode(JSON.stringify(worldContent, null, 2)));
                        await git.add({ fs, dir, filepath: `worlds/${safeFileName}` });
                    }
                }
            });

            // Чаты
            await pfs.mkdir(`${dir}/chats`).catch(() => {});
            for (const char of charsData.filter(validateCharacter)) {
                const chatsReq = await fetch('/api/characters/chats', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ avatar_url: char.avatar }) });
                if (chatsReq.ok) {
                    let chats = await chatsReq.json();
                    
                    // --- БЕЗОПАСНОЕ ПРЕОБРАЗОВАНИЕ (ИСПРАВЛЕНИЕ ОШИБКИ chats is not iterable) ---
                    if (!Array.isArray(chats)) {
                        if (chats && Array.isArray(chats.data)) {
                            chats = chats.data;
                        } else if (chats && typeof chats === 'object') {
                            chats = Object.values(chats);
                        } else {
                            chats = [];
                        }
                    }

                    const folderName = char.avatar.replace(/\.(png|webp)$/i, '');
                    await pfs.mkdir(`${dir}/chats/${folderName}`).catch(() => {});

                    for (const chat of chats) {
                        if (!chat || !chat.file_name) continue;
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
                fs, dir,
                message: `Auto-sync: ${new Date().toLocaleString()}`,
                author: { name: 'ST User', email: 'user@st.local' }
            });

            await git.push({
                fs, http: GitHttp, dir,
                url: authenticatedUrl,
                corsProxy: 'https://cors.isomorphic-git.org',
                remote: 'origin',
                ref: 'main',
                remoteRef: 'refs/heads/main',
                force: true,
                onMessage: (msg) => console.log('[ST-Git-Sync] GitHub:', msg)
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

        // Очищаем токен из памяти после операции, если он не сохранён постоянно
        if (!extension_settings[extensionName].rememberToken) {
            sessionToken = null;
        }
    }
}

jQuery(initExtension);
