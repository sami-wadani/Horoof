// ==========================================
// 1. المتغيرات الأساسية والاتصال السحابي
// ==========================================
let roomCode = "andalus-room-1";
let userRole = "admin";
let db = null;
let isProcessingClick = false; 
let localTimerInterval = null;

// الـ 20 حرفاً الافتراضية للشبكة (4 صفوف × 5 أعمدة)
const defaultLetters = ['أ','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش','ص','ض','ط','ظ','ع','غ','ف'];
// قائمة شاملة لجميع الحروف الأبجدية للقوائم المنسدلة
const allArabicLetters = ['أ','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش','ص','ض','ط','ظ','ع','غ','ف','ق','ك','ل','م','ن','ه','و','ي'];

let gameState = {
    teams: [],
    stages: [
        { id: 1, name: "المرحلة الأولى", selectedQuestionIds: {}, gridLetters: [...defaultLetters], hexOwnership: {}, specialCells: {} },
        { id: 2, name: "المرحلة الثانية", selectedQuestionIds: {}, gridLetters: [...defaultLetters], hexOwnership: {}, specialCells: {} }
    ],
    currentStageIndex: 0,
    defaultTime: 30,
    flashingHex: null,
    activeQuestion: null,
    isQuestionRevealed: false,
    areChoicesRevealed: false,
    timerSeconds: 30,
    winnerAnnouncement: null
};

let globalBankState = {}; 

const gameSounds = {
    tick: new Audio('https://freesound.org/data/previews/254/254316_4062622-lq.mp3'),
    correct: new Audio('https://freesound.org/data/previews/320/320655_527080-lq.mp3'),
    wrong: new Audio('https://freesound.org/data/previews/142/142608_1840739-lq.mp3'),
    win: new Audio('https://freesound.org/data/previews/274/274180_4062622-lq.mp3')
};

function playSound(type) {
    if (gameSounds[type]) {
        gameSounds[type].currentTime = 0;
        gameSounds[type].play().catch(() => {});
    }
}

// تنظيف أي كائن من قيم undefined قبل إرساله إلى Firebase لمنع توقف الأزرار
function sanitizeForFirebase(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// ==========================================
// 2. تشغيل التطبيق ونظام الغرف
// ==========================================
function initApp(role) {
    userRole = role;
    const roomInput = document.getElementById('room-code-input');
    roomCode = (roomInput && roomInput.value.trim()) ? roomInput.value.trim() : "andalus-room-1";
    
    if (userRole === 'screen') {
        document.body.classList.add('projector-mode');
        const codeSpan = document.getElementById('display-room-code');
        if (codeSpan) codeSpan.innerText = roomCode;
    } else {
        document.body.classList.remove('projector-mode');
    }

    // إغلاق نافذة البداية فوراً
    const roleModal = document.getElementById('role-selector-modal');
    if (roleModal) {
        roleModal.classList.remove('active');
    }

    renderUIFromState();
    initFirebaseAndSync();
}

function openProjectorWindow() {
    const url = `${window.location.pathname}?room=${encodeURIComponent(roomCode)}&role=screen`;
    window.open(url, '_blank');
}

function initFirebaseAndSync() {
    try {
        const firebaseConfig = { databaseURL: "https://haroof-quiz-default-rtdb.firebaseio.com/" };
        if (typeof firebase !== 'undefined') {
            if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
            db = firebase.database();
        }
    } catch (e) {
        console.warn("Firebase connection warning:", e);
    }

    if (!db) return;

    // 1. مزامنة حالة اللعبة
    db.ref(`rooms/${roomCode}/state`).on('value', (snapshot) => {
        const serverData = snapshot.val();
        if (serverData) {
            gameState.teams = Array.isArray(serverData.teams) ? serverData.teams : [];
            gameState.stages = Array.isArray(serverData.stages) && serverData.stages.length > 0 
                ? serverData.stages 
                : [{ id: 1, name: "المرحلة الأولى", selectedQuestionIds: {}, gridLetters: [...defaultLetters], hexOwnership: {}, specialCells: {} }];
            
            gameState.stages.forEach(st => {
                if (!Array.isArray(st.gridLetters) || st.gridLetters.length !== 20) {
                    st.gridLetters = [...defaultLetters];
                }
                if (!st.selectedQuestionIds) st.selectedQuestionIds = {};
                if (!st.hexOwnership) st.hexOwnership = {};
                if (!st.specialCells) st.specialCells = {};
            });

            gameState.currentStageIndex = (typeof serverData.currentStageIndex === 'number' && gameState.stages[serverData.currentStageIndex])
                ? serverData.currentStageIndex : 0;
            gameState.defaultTime = serverData.defaultTime || 30;
            gameState.flashingHex = serverData.flashingHex || null;
            gameState.activeQuestion = serverData.activeQuestion || null;
            gameState.isQuestionRevealed = Boolean(serverData.isQuestionRevealed);
            gameState.areChoicesRevealed = Boolean(serverData.areChoicesRevealed);
            gameState.timerSeconds = serverData.timerSeconds ?? gameState.defaultTime;
            gameState.winnerAnnouncement = serverData.winnerAnnouncement || null;

            renderUIFromState();
        } else {
            if (userRole === 'admin') pushStateToCloud();
            renderUIFromState();
        }
    });

    // 2. مزامنة بنك الأسئلة المركزي
    db.ref(`rooms/${roomCode}/bank`).on('value', (snapshot) => {
        globalBankState = snapshot.val() || {};
        populateLetterDropdowns();
    });

    // 3. مزامنة الأوامر اللحظية (المؤقت والصوت والاحتفال)
    db.ref(`rooms/${roomCode}/commands`).on('value', (snapshot) => {
        const cmd = snapshot.val();
        if (!cmd || (Date.now() - cmd.timestamp > 5000)) return; 
        
        if (userRole === 'screen') {
            switch (cmd.action) {
                case 'START_TIMER': startLocalTimerLogic(); break;
                case 'SHOW_CHOICES': document.getElementById('choices-container').classList.remove('hidden'); break;
                case 'ADD_TIME': gameState.timerSeconds += 15; updateTimerUI(); break;
                case 'WRONG_ANSWER': stopLocalTimerLogic(); playSound('wrong'); break;
                case 'CLOSE_QUESTION': stopLocalTimerLogic(); break;
                case 'CELEBRATE': 
                    if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } }); 
                    playSound('correct'); 
                    break;
                case 'WIN_STAGE':
                    if (typeof confetti === 'function') confetti({ particleCount: 200, spread: 100, origin: { y: 0.5 } });
                    playSound('win');
                    break;
            }
        }
    });
}

function pushStateToCloud() {
    if (db && userRole === 'admin') {
        db.ref(`rooms/${roomCode}/state`).set(sanitizeForFirebase(gameState));
    }
}

function pushBankToCloud() {
    if (db && userRole === 'admin') {
        db.ref(`rooms/${roomCode}/bank`).set(sanitizeForFirebase(globalBankState));
    }
}

function sendLiveCommand(action) {
    if (userRole === 'admin' && db) {
        db.ref(`rooms/${roomCode}/commands`).set({ action: action, timestamp: Date.now() });
    }
}

// ==========================================
// 3. رسم وتحديث الواجهة (UI Rendering)
// ==========================================
function renderUIFromState() {
    if (gameState.teams && gameState.teams.length > 0) {
        document.getElementById('setup-screen').classList.add('hidden');
        document.getElementById('waiting-screen').classList.add('hidden');
        document.getElementById('game-screen').classList.remove('hidden');
        renderStagesBar();
        renderScoreboard();
        renderManualWinButtons();
        renderHexGrid();
    } else {
        document.getElementById('game-screen').classList.add('hidden');
        if (userRole === 'admin') {
            document.getElementById('setup-screen').classList.remove('hidden');
            document.getElementById('waiting-screen').classList.add('hidden');
            const teamsCont = document.getElementById('teams-input');
            if (teamsCont && teamsCont.children.length === 0) renderTeamInputs();
        } else {
            document.getElementById('setup-screen').classList.add('hidden');
            document.getElementById('waiting-screen').classList.remove('hidden');
        }
    }

    // نافذة السؤال
    const modal = document.getElementById('question-modal');
    if (gameState.activeQuestion) {
        // على شاشة الجمهور: لا تفتح النافذة إلا إذا ضغط المشرف على "إظهار السؤال للجمهور"
        if (userRole === 'screen' && !gameState.isQuestionRevealed) {
            modal.classList.remove('active');
        } else {
            modal.classList.add('active');
            document.getElementById('question-text').innerText = gameState.activeQuestion.text || '';
            
            const ansText = document.getElementById('admin-answer-text');
            if (ansText) ansText.innerText = gameState.activeQuestion.answer || '';

            const cCont = document.getElementById('choices-container');
            if (gameState.activeQuestion.choices && gameState.activeQuestion.choices.length > 1) {
                cCont.innerHTML = '';
                gameState.activeQuestion.choices.forEach(c => {
                    cCont.innerHTML += `<div class="bg-slate-800 p-2.5 rounded-lg border border-slate-700 font-bold">${c}</div>`;
                });
                if (userRole === 'admin' || gameState.areChoicesRevealed) cCont.classList.remove('hidden');
                else cCont.classList.add('hidden'); 
            } else {
                cCont.classList.add('hidden');
            }

            const banner = document.getElementById('golden-banner');
            if (gameState.activeQuestion.isGolden) banner.classList.remove('hidden');
            else banner.classList.add('hidden');

            document.getElementById('timer-text').innerText = gameState.timerSeconds;
            document.getElementById('timer-bar').style.width = `${Math.max(0, (gameState.timerSeconds / gameState.defaultTime) * 100)}%`;

            if (userRole === 'admin') {
                const assignDiv = document.getElementById('assign-points-buttons');
                const stealDiv = document.getElementById('steal-points-buttons');
                assignDiv.innerHTML = ''; stealDiv.innerHTML = '';
                gameState.teams.forEach((t, idx) => {
                    const bHtml = `<button type="button" onclick="cmdAssignPoint(${idx})" class="px-4 py-2 rounded-lg text-white font-bold text-xs cursor-pointer shadow hover:opacity-90" style="background-color: ${t.color}">${t.name}</button>`;
                    assignDiv.innerHTML += bHtml;
                    stealDiv.innerHTML += bHtml;
                });
            }
        }
    } else {
        modal.classList.remove('active');
    }

    // نافذة إعلان الفوز اليدوي أو الترتيب النهائي
    const resultsModal = document.getElementById('final-results-modal');
    if (gameState.winnerAnnouncement) {
        document.getElementById('results-modal-title').innerText = gameState.winnerAnnouncement.title || "🎉 مبروك الفوز! 🎉";
        document.getElementById('winner-message').innerHTML = gameState.winnerAnnouncement.message || "";
        
        let html = '';
        const sorted = [...gameState.teams].sort((a, b) => b.score - a.score);
        sorted.forEach((t, i) => {
            html += `<div class="bg-slate-800 p-3 rounded-xl flex justify-between items-center text-sm border border-slate-700" style="border-right: 5px solid ${t.color}">
                <span>${i+1}. ${t.name}</span><span class="font-bold text-amber-400 text-lg">${t.score} نقطة</span>
            </div>`;
        });
        document.getElementById('final-rankings').innerHTML = html;
        resultsModal.classList.add('active');
    } else {
        resultsModal.classList.remove('active');
    }
}

// ==========================================
// 4. إعداد الفرق (2 إلى 4 فرق) ولوحة النقاط
// ==========================================
function renderTeamInputs() {
    const countSelect = document.getElementById('team-count');
    const count = countSelect ? parseInt(countSelect.value) : 2;
    const container = document.getElementById('teams-input');
    if (!container) return;

    const colors = ['#ef4444', '#3b82f6', '#22c55e', '#a855f7'];
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const existingTeam = gameState.teams && gameState.teams[i];
        const tName = existingTeam ? existingTeam.name : `فريق ${i+1}`;
        const tColor = existingTeam ? existingTeam.color : colors[i];

        container.innerHTML += `<div>
            <label class="block text-xs mb-1 text-gray-400">اسم الفريق ${i+1}</label>
            <input type="text" id="t-name-${i}" value="${tName}" class="w-full p-2 bg-slate-950 border border-slate-800 rounded text-xs mb-1 text-white outline-none">
            <input type="color" id="t-color-${i}" value="${tColor}" class="w-full h-8 bg-slate-950 rounded cursor-pointer">
        </div>`;
    }
}

function openSetupScreen() {
    if (userRole === 'screen') return;
    const countSelect = document.getElementById('team-count');
    if (countSelect && gameState.teams && gameState.teams.length >= 2) {
        countSelect.value = gameState.teams.length;
    }
    renderTeamInputs();
    document.getElementById('game-screen').classList.add('hidden');
    document.getElementById('setup-screen').classList.remove('hidden');
}

function startNewMatch() {
    const count = parseInt(document.getElementById('team-count').value) || 2;
    gameState.defaultTime = parseInt(document.getElementById('default-time').value) || 30;
    const newTeams = [];
    for (let i = 0; i < count; i++) {
        const oldScore = (gameState.teams && gameState.teams[i]) ? gameState.teams[i].score : 0;
        const oldStages = (gameState.teams && gameState.teams[i]) ? gameState.teams[i].stagesWon : 0;
        newTeams.push({ 
            name: document.getElementById(`t-name-${i}`).value.trim() || `فريق ${i+1}`, 
            color: document.getElementById(`t-color-${i}`).value, 
            score: oldScore, 
            stagesWon: oldStages 
        });
    }
    gameState.teams = newTeams;
    generateSpecialCell();
    pushStateToCloud();
    renderUIFromState();
}

function generateSpecialCell() {
    const stage = gameState.stages[gameState.currentStageIndex];
    if (!stage.specialCells) stage.specialCells = {};
    if (Object.keys(stage.specialCells).length === 0) {
        stage.specialCells[`${Math.floor(Math.random() * 4)}-${Math.floor(Math.random() * 5)}`] = "golden";
    }
}

function renderScoreboard() {
    const board = document.getElementById('scoreboard');
    if (!board) return;
    board.innerHTML = '';
    gameState.teams.forEach(t => {
        board.innerHTML += `
            <div class="bg-slate-900 border border-slate-800 px-4 py-1.5 rounded-lg flex items-center justify-between gap-4 shadow-sm transition w-auto" style="border-right: 4px solid ${t.color}">
                <span class="font-bold text-sm text-slate-200">${t.name}</span>
                <span class="text-xs text-gray-400 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                    النقاط: <span class="font-black text-amber-400 text-sm">${t.score}</span>
                </span>
            </div>`;
    });
}

function renderManualWinButtons() {
    const container = document.getElementById('manual-win-buttons');
    if (!container) return;
    container.innerHTML = '';

    gameState.teams.forEach((t, idx) => {
        container.innerHTML += `
            <button type="button" onclick="declareStageWinner(${idx})" class="px-2.5 py-1 rounded-lg text-white font-bold text-xs transition shadow cursor-pointer hover:opacity-90" style="background-color: ${t.color}">
                🏆 ${t.name}
            </button>`;
    });
}

function declareStageWinner(teamIndex) {
    if (userRole === 'screen') return;
    const team = gameState.teams[teamIndex];
    if (!team) return;

    const stage = gameState.stages[gameState.currentStageIndex];
    if (!confirm(`هل أنت متأكد من إعلان فوز (${team.name}) في (${stage.name})؟`)) return;

    team.stagesWon = (team.stagesWon || 0) + 1;
    gameState.winnerAnnouncement = {
        title: `🎉 بطل ${stage.name} 🎉`,
        message: `🏆 الفائز بالمرحلة: <span style="color:${team.color}">${team.name}</span>`
    };

    if (typeof confetti === 'function') confetti({ particleCount: 200, spread: 100, origin: { y: 0.5 } });
    playSound('win');

    pushStateToCloud();
    sendLiveCommand('WIN_STAGE');
    renderUIFromState();
}

function closeResultsModal() {
    if (userRole === 'screen') return;
    gameState.winnerAnnouncement = null;
    pushStateToCloud();
    renderUIFromState();
}

// ==========================================
// 5. شبكة الخلايا السداسية واختيار الأسئلة
// ==========================================
function renderHexGrid() {
    const grid = document.getElementById('hex-grid');
    const stage = gameState.stages[gameState.currentStageIndex];
    const letters = (stage.gridLetters && stage.gridLetters.length === 20) ? stage.gridLetters : defaultLetters;
    
    if (grid.children.length === 4) {
        let lIdx = 0;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 5; c++) {
                const hex = grid.children[r].children[c];
                const cellId = `${r}-${c}`;
                const hexInner = hex.querySelector('.hex-inner');
                const currentLetter = letters[lIdx % 20];
                
                hex.className = 'hex';
                hexInner.style.backgroundColor = '#1e293b';
                hexInner.innerText = currentLetter;
                
                if (stage.hexOwnership && stage.hexOwnership[cellId] !== undefined && gameState.teams[stage.hexOwnership[cellId]]) {
                    hex.classList.add('owned');
                    hexInner.style.backgroundColor = gameState.teams[stage.hexOwnership[cellId]].color;
                    hex.onclick = null;
                } else {
                    if (userRole === 'admin') hex.onclick = () => selectHex(r, c, currentLetter);
                    else hex.onclick = null;
                }

                if ((gameState.flashingHex && gameState.flashingHex.r === r && gameState.flashingHex.c === c) || 
                    (gameState.activeQuestion && gameState.activeQuestion.r === r && gameState.activeQuestion.c === c)) {
                    hex.classList.add('flashing');
                }
                lIdx++;
            }
        }
        return;
    }

    grid.innerHTML = '';
    let lIdx = 0;
    for (let r = 0; r < 4; r++) {
        const row = document.createElement('div');
        row.className = 'hex-row';
        if (r % 2 !== 0) row.classList.add('offset');
        for (let c = 0; c < 5; c++) {
            const cellId = `${r}-${c}`;
            const currentLetter = letters[lIdx % 20];
            const hex = document.createElement('div');
            hex.className = 'hex';
            hex.id = `hex-${r}-${c}`;
            
            let innerBg = '#1e293b';
            let isOwned = false;
            if (stage.hexOwnership && stage.hexOwnership[cellId] !== undefined && gameState.teams[stage.hexOwnership[cellId]]) {
                isOwned = true;
                hex.classList.add('owned');
                innerBg = gameState.teams[stage.hexOwnership[cellId]].color;
            }

            if ((gameState.flashingHex && gameState.flashingHex.r === r && gameState.flashingHex.c === c) || 
                (gameState.activeQuestion && gameState.activeQuestion.r === r && gameState.activeQuestion.c === c)) {
                hex.classList.add('flashing');
            }

            hex.innerHTML = `<div class="hex-inner" style="background-color: ${innerBg}">${currentLetter}</div>`;
            if (!isOwned && userRole === 'admin') hex.onclick = () => selectHex(r, c, currentLetter);
            row.appendChild(hex);
            lIdx++;
        }
        grid.appendChild(row);
    }
}

// مطابقة ذكية للحرف (تدعم أ/ا و ه/هـ)
function getQuestionsForLetterFromBank(letter) {
    if (globalBankState[letter] && globalBankState[letter].length > 0) return globalBankState[letter];
    if (letter === 'أ' && globalBankState['ا']) return globalBankState['ا'];
    if (letter === 'ا' && globalBankState['أ']) return globalBankState['أ'];
    if (letter === 'ه' && globalBankState['هـ']) return globalBankState['هـ'];
    if (letter === 'هـ' && globalBankState['ه']) return globalBankState['ه'];
    return [];
}

function selectHex(r, c, letter) {
    if (userRole === 'screen' || isProcessingClick) return;
    const stage = gameState.stages[gameState.currentStageIndex];
    if (stage.hexOwnership && stage.hexOwnership[`${r}-${c}`] !== undefined) return;

    isProcessingClick = true;
    const hexEl = document.getElementById(`hex-${r}-${c}`);
    if (hexEl) hexEl.classList.add('flashing');
    
    gameState.flashingHex = { r, c };
    pushStateToCloud();

    setTimeout(() => {
        let qData = null;
        const bankList = getQuestionsForLetterFromBank(letter);

        // 1. البحث في الأسئلة المخصصة للمرحلة أولاً
        if (stage.selectedQuestionIds && stage.selected