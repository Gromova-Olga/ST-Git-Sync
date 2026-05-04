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
        toastr.success('Настройки обновлены');
    });

    $('#sync-pull-btn').on('click', async () => {
        const token = await getToken();
        if (!token) return;
        executeSyncAction('pull', token);
    });

    $('#sync-push-btn').on('click', async () => {
        const token = await getToken();
        if (!token) return;
        executeSyncAction('push', token);
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
    toastr.error('Синхронизация невозможна без токена');
    return null;
}

function updateIndicator(active) {
    $('#sync-auth-indicator').css('background', active ? '#2ecc71' : '#e74c3c');
    $('#sync-log').text(active ? 'Токен активен' : 'Требуется ввод токена');
}

async function executeSyncAction(action, token) {
    const repoUrl = extension_settings[extensionName].repoUrl;
    const dir = '/sillytavern-sync';
    
    if (!repoUrl) return toastr.error('Введите URL репозитория!');

    $('#sync-log').text(`Запуск ${action}...`).css('color', '#fff');

    // --- ЗАГОЛОВКИ ОПРЕДЕЛЯЕМ ОДИН РАЗ ---
    const baseHeaders = getRequestHeaders();
    const jsonHeaders = Object.assign({}, baseHeaders, { 'Content-Type': 'application/json' });
    
    const formHeaders = {};
    for (const [key, value] of Object.entries(baseHeaders)) {
        if (key.toLowerCase() !== 'content-type') formHeaders[key] = value;
    }

    try {
        const hasGit = await pfs.stat(dir + '/.git').catch(() => false);
        
        if (!hasGit) {
            $('#sync-log').text('Первичное клонирование репозитория...');
            await git.clone({
                fs,
                http: GitHttp,
                dir,
                corsProxy: 'https://cors.isomorphic-git.org',
                url: repoUrl,
                onAuth: () => ({ username: token }),
                singleBranch: true,
                depth: 1
            });
        }

        if (action === 'pull') {
            $('#sync-log').text('Стягиваем изменения (Pull)...');

            await git.pull({
                fs,
                http: GitHttp,
                dir,
                corsProxy: 'https://cors.isomorphic-git.org',
                url: repoUrl,
                onAuth: () => ({ username: token, password: '' }),
                author: { name: 'ST User', email: 'user@st.local' }
            });

            $('#sync-log').text('Чтение данных...');

            const charsFile = await pfs.readFile(`${dir}/characters.json`, 'utf8').catch(() => '[]');
            let charsData = JSON.parse(charsFile);
            if (!Array.isArray(charsData)) charsData = Object.values(charsData);

            // --- 1. ИМПОРТ ПЕРСОНАЖЕЙ ---
            $('#sync-log').text(`Импорт персонажей (${charsData.length})...`);
            for (const char of charsData) {
                if (!char.avatar) continue;
                try {
                    const filePath = `${dir}/characters/${char.avatar}`;
                    const rawData = await pfs.readFile(filePath);
                    const uint8Array = rawData instanceof Uint8Array ? rawData : new Uint8Array(Object.values(rawData));
                    if (uint8Array.length < 100) continue;

                    // Удаление старой версии
                    await fetch('/api/characters/delete', {
                        method: 'POST',
                        headers: jsonHeaders,
                        body: JSON.stringify({ avatar_url: char.avatar })
                    }).catch(() => {});

                    const fd = new FormData();
                    fd.append('avatar', new Blob([uint8Array]), char.avatar);
                    fd.append('file_type', char.avatar.endsWith('.webp') ? 'webp' : 'png');

                    await fetch('/api/characters/import', { method: 'POST', headers: formHeaders, body: fd });
                    console.log(`✅ Персонаж импортирован: ${char.avatar}`);
                } catch (e) { console.error(`Ошибка персонажа ${char.avatar}:`, e); }
            }

            // --- 2. ИМПОРТ МИРОВ ---
            $('#sync-log').text('Импорт миров...');
            const worldsList = await pfs.readdir(`${dir}/worlds`).catch(() => []);
            for (const file of worldsList) {
                try {
                    const rawData = await pfs.readFile(`${dir}/worlds/${file}`);
                    const fd = new FormData();
                    fd.append('avatar', new Blob([rawData]), file);
                    await fetch('/api/worldinfo/import', { method: 'POST', headers: formHeaders, body: fd });
                    console.log(`✅ Мир импортирован: ${file}`);
                } catch (e) { console.error(`Ошибка мира ${file}:`, e); }
            }

            // --- 3. ИМПОРТ ЧАТОВ (через /api/chats/save) ---
            $('#sync-log').text('Импорт чатов...');
            const charFolders = await pfs.readdir(`${dir}/chats`).catch(() => []);
            
            for (const charFolderName of charFolders) {
                const charChats = await pfs.readdir(`${dir}/chats/${charFolderName}`).catch(() => []);
                const charInfo = charsData.find(c => c.name === charFolderName);
                const avatarUrl = String(charInfo ? charInfo.avatar : `${charFolderName}.png`);

                // Создаём директорию персонажа, если её нет
                try {
                    await fetch('/api/chats/get', {
                        method: 'POST',
                        headers: jsonHeaders,
                        body: JSON.stringify({ avatar_url: avatarUrl, file_name: '' })
                    });
                } catch (e) { /* директория уже есть или создастся при первом чате */ }

                for (const chatFile of charChats) {
                    try {
                        const rawData = await pfs.readFile(`${dir}/chats/${charFolderName}/${chatFile}`, 'utf8');
                        
                        // Парсим JSONL в массив объектов
                        const lines = rawData.split('\n').filter(line => line.trim());
                        const chatData = lines.map(line => {
                            try {
                                return JSON.parse(line);
                            } catch (e) {
                                console.warn(`Невалидная строка в ${chatFile}:`, line);
                                return null;
                            }
                        }).filter(x => x !== null);

                        if (chatData.length === 0) {
                            console.warn(`Пустой чат пропущен: ${chatFile}`);
                            continue;
                        }

                        // Имя файла без расширения — сервер сам добавит .jsonl
                        const fileName = chatFile.replace(/\.jsonl$/i, '');

                        const response = await fetch('/api/chats/save', {
                            method: 'POST',
                            headers: jsonHeaders,
                            body: JSON.stringify({
                                avatar_url: avatarUrl,
                                chat: chatData,
                                file_name: fileName,
                                force: true
                            })
                        });

                        if (response.ok) {
                            console.log(`✅ Чат сохранён: ${charFolderName} -> ${chatFile}`);
                        } else {
                            const err = await response.text();
                            console.error(`❌ Ошибка сохранения чата ${chatFile}:`, err);
                        }
                    } catch (e) {
                        console.error(`❌ Ошибка чата ${chatFile}:`, e);
                    }
                }
            }

            $('#sync-log').text('Готово! Обновите страницу (F5).').css('color', '#4CAF50');
            toastr.success('Синхронизация завершена');

        } else if (action === 'push') {
            $('#sync-log').text('Сбор данных из таверны (Push)...');
            
            let charsData = []; 
            try {
                const charsReq = await fetch('/api/characters/all', {
                    method: 'POST', headers: jsonHeaders, body: JSON.stringify({})
                });
                
                if (!charsReq.ok) throw new Error(`Сервер ответил: ${charsReq.status}`);
                charsData = await charsReq.json(); 

                await pfs.mkdir(`${dir}/characters`).catch(() => {});
                $('#sync-log').text(`Подготовка карточек (0/${charsData.length})...`);

                let currentCount = 0;
                for (const char of charsData) {
                    if (!char.avatar) continue;
                    try {
                        const avatarReq = await fetch(`/characters/${encodeURIComponent(char.avatar)}`, { headers: baseHeaders });
                        if (!avatarReq.ok) {
                            currentCount++; continue;
                        }
                        const arrayBuffer = await avatarReq.arrayBuffer();
                        await pfs.writeFile(`${dir}/characters/${char.avatar}`, new Uint8Array(arrayBuffer));
                        await git.add({ fs, dir, filepath: `characters/${char.avatar}` });
                        console.log(`✅ ${char.name || char.avatar} добавлен в коммит`);
                    } catch (e) { console.warn(`⚠️ Ошибка файла ${char.avatar}:`, e); }
                    currentCount++;
                }

                await pfs.writeFile(`${dir}/characters.json`, JSON.stringify(charsData, null, 2));
                await git.add({ fs, dir, filepath: 'characters.json' });

            } catch (fsError) {
                console.error("❌ Ошибка при сборе персонажей:", fsError);
                return toastr.error("Не удалось вытянуть данные из таверны");
            }

            // === СБОР МИРОВ (LOREBOOKS) ===
            $('#sync-log').text('Сбор миров (Worlds)...');
            try {
                await pfs.mkdir(`${dir}/worlds`).catch(() => {});
                
                let worlds = [];
                // Берем из глобальной переменной, защищаясь от объектов вместо строк
                if (window.world_names && Array.isArray(window.world_names)) {
                    worlds = window.world_names.map(w => typeof w === 'object' ? w.name : w);
                }
                
                // Запасной вариант: парсим меню (исправлено)
                if (worlds.length === 0) {
                    $('#world_editor_select option').each(function() {
                        const val = $(this).attr('value'); // Надежнее брать value, а не текст
                        const txt = $(this).text().trim();
                        
                        // Игнорируем английские и русские плейсхолдеры, а также разделители
                        if (val && txt && 
                            !txt.includes('Select') && 
                            !txt.includes('No worlds') && 
                            !txt.includes('Выберите') && 
                            !txt.startsWith('---')) {
                            worlds.push(val);
                        }
                    });
                }
                
                // Финальная очистка: убираем дубликаты, пустые значения и мусорные индексы (0, 1, 2...)
                worlds = [...new Set(worlds)].filter(w => {
                    const isArrayIndexBug = typeof w === 'string' && w.length < 3 && !isNaN(w); 
                    return w && typeof w === 'string' && !w.startsWith('---') && !isArrayIndexBug;
                });
                
                for (const worldName of worlds) {
                    const wReq = await fetch('/api/worldinfo/get', { 
                        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: worldName }) 
                    });
                    
                    if (wReq.ok) {
                        const worldContent = await wReq.json();
                        if (worldContent && Object.keys(worldContent).length > 0) {
                            const jsonString = JSON.stringify(worldContent, null, 2);
                            const uint8 = new TextEncoder().encode(jsonString);
                            
                            const safeFileName = worldName.toLowerCase().endsWith('.json') ? worldName : `${worldName}.json`;
                            await pfs.writeFile(`${dir}/worlds/${safeFileName}`, uint8);
                            await git.add({ fs, dir, filepath: `worlds/${safeFileName}` });
                        }
                    }
                }
            } catch (e) { console.error('❌ Ошибка парсинга миров:', e); }

            // === СБОР ГРУППОВЫХ ЧАТОВ ===
            $('#sync-log').text('Сбор групповых чатов...');
            try {
                await pfs.mkdir(`${dir}/group_chats`).catch(() => {});
                const groupsReq = await fetch('/api/groups/all', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({}) });
                if (groupsReq.ok) {
                    const groups = await groupsReq.json();
                    for (const group of groups) {
                        const gReq = await fetch(`/group_chats/${group.id}.json`, { headers: baseHeaders });
                        if (gReq.ok) {
                            const uint8 = new Uint8Array(await gReq.arrayBuffer());
                            await pfs.writeFile(`${dir}/group_chats/${group.id}.json`, uint8);
                            await git.add({ fs, dir, filepath: `group_chats/${group.id}.json` });
                        }
                    }
                }
            } catch (e) { console.error('❌ Ошибка парсинга групп:', e); }

            // === СБОР ЧАТОВ (ИСТОРИИ ПЕРЕПИСОК) ===
            $('#sync-log').text('Сбор историй чатов...');
            try {
                await pfs.mkdir(`${dir}/chats`).catch(() => {});
                
                for (const char of charsData) {
                    if (!char.avatar) continue;

                    const chatsReq = await fetch('/api/characters/chats', {
                        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ avatar_url: char.avatar })
                    });
                    
                    if (chatsReq.ok) {
                        const chatsData = await chatsReq.json();
                        const chats = Array.isArray(chatsData) ? chatsData : Object.values(chatsData); 
                        
                        if (chats.length > 0) {
                            const folderName = char.avatar.replace(/\.(png|webp)$/i, '');
                            await pfs.mkdir(`${dir}/chats/${folderName}`).catch(() => {});
                            
                            for (let chat of chats) {
                                let rawFileName = chat.file_name; 
                                if (!rawFileName) continue;
                                
                                let apiFileName = rawFileName.replace(/\.jsonl$/i, '');
                                let saveFileName = apiFileName + '.jsonl';

                                const cReq = await fetch('/api/chats/get', {
                                    method: 'POST', headers: jsonHeaders,
                                    body: JSON.stringify({
                                        ch_name: folderName,
                                        file_name: apiFileName,
                                        avatar_url: char.avatar
                                    })
                                });

                                if (cReq.ok) {
                                    const chatContent = await cReq.json();
                                    let messages = [];
                                    if (Array.isArray(chatContent)) messages = chatContent;
                                    else if (chatContent && Array.isArray(chatContent.chat)) messages = chatContent.chat;
                                    else if (chatContent && Array.isArray(chatContent.data)) messages = chatContent.data;
                                    else messages = [chatContent];

                                    if (messages.length > 0) {
                                        const jsonlString = messages.map(msg => JSON.stringify(msg)).join('\n');
                                        const uint8 = new TextEncoder().encode(jsonlString);
                                        await pfs.writeFile(`${dir}/chats/${folderName}/${saveFileName}`, uint8);
                                        await git.add({ fs, dir, filepath: `chats/${folderName}/${saveFileName}` });
                                        console.log(`✅ Чат добавлен: ${folderName} -> ${saveFileName} (${messages.length} сообщений)`);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) { console.error('❌ Ошибка в цикле сбора чатов:', e); }

            $('#sync-log').text('Создание коммита...');
            
            await git.commit({
                fs,
                dir,
                author: { name: 'ST User', email: 'user@st.local' },
                message: `Auto-sync: ${new Date().toLocaleString()}`
            });

            $('#sync-log').text('Отправка на GitHub...');
            
            const authUrl = repoUrl.replace('https://', `https://${token}@`);
            
            await git.push({
                fs,
                http: GitHttp,
                dir,
                corsProxy: 'https://cors.isomorphic-git.org',
                url: authUrl,
                force: true
            });
            $('#sync-log').text('Push успешен!').css('color', '#4CAF50');
            toastr.success('Данные отправлены на GitHub');
        }

    } catch (err) {
        console.error('Git Error:', err);
        toastr.error(`Ошибка Git: ${err.message}`);
        $('#sync-log').text('Ошибка. Откройте консоль (F12)').css('color', '#f44336');
    }
}

jQuery(initExtension);
