/* ==========================================================================
   Pikachu Cổ Điển — bản tối ưu cho di động & máy tính
   Thay cho: pikachu1.js (swfobject + clone jQuery, 75KB) + pikachu2.js + score.min.js.js

   Nguyên tắc: giữ nguyên hệ toạ độ gốc (ô 42x52) và toàn bộ thuật toán dò
   đường của bản cũ; việc co giãn màn hình do transform: scale() đảm nhiệm,
   nên thuật toán không phải đổi một dòng nào.
   ========================================================================== */
(function () {
'use strict';

/* ------------------------------------------------------------------ hằng số */

var PW = 42, PH = 52;          // kích thước một ô lưới (toạ độ nội bộ)
var IW = 40, IH = 50;          // kích thước một icon trong sprite
var MAX_SCALE = 1.35;          // không phóng quá to trên màn hình lớn
var TRACK_THICK = 8;           // bề dày thanh thời gian (khớp với CSS)
var LEVELS = 9;
var SEC_PER_PIECE = 4;         // 16x9 -> 576s, đúng bằng nhịp của bản gốc
var HINT_MAX = 3;              // số lượt gợi ý cho CẢ VÁN (bàn 1 -> 9), không phải mỗi bàn

/* Điểm CHUẨN HOÁ theo bàn, không theo số quân. Bàn cờ co theo màn hình nên nếu
   cứ 10 điểm/cặp thì người chơi máy tính (72 cặp) ăn đứt người chơi điện thoại
   ngang (30 cặp) hơn gấp đôi — bảng xếp hạng chung sẽ vô nghĩa. Với cách này,
   ăn xong một bàn luôn đúng 720 điểm và thưởng thời gian tối đa 576, mọi cỡ bàn
   như nhau. Hai số này phải khớp với PIKA_MAX_PER_LEVEL bên leaderboard.php. */
var PTS_LEVEL = 720;
var PTS_TIME  = 576;

/* Các cỡ bàn khả dụng. Ràng buộc: cols*rows chia hết cho 4 và cols*rows/4 <= 36
   (chỉ có 36 icon). Danh sách có cả dạng nằm ngang lẫn dạng đứng — màn hình dọc
   của điện thoại thừa chiều cao nhưng thiếu chiều ngang, nên bàn nhiều hàng ít
   cột chứa được nhiều quân hơn hẳn ở cùng cỡ ô. */
var PRESETS = [
    [16, 9],            // 144 — máy tính
    [10, 12], [8, 14],  // 120 / 112 — điện thoại dọc
    [14, 8],            // 112
    [12, 9], [9, 12],   // 108
    [16, 6], [12, 8], [8, 12],
    [10, 8], [8, 10],
    [8, 9], [6, 12],
    [12, 5],            // 60 — điện thoại nằm ngang
    [8, 7], [8, 6], [6, 6]
].filter(function (p) { var n = p[0] * p[1]; return n % 4 === 0 && n / 4 <= 36; });

var UU = [0, 0, 1, -1], VV = [1, -1, 0, 0];

/* -------------------------------------------------------------- trạng thái */

var COLS = 16, ROWS = 9;
var MI = COLS + 2, MJ = ROWS + 2;      // ma trận có viền ngoài để đường nối đi vòng
var BW = MI * PW, BH = MJ * PH;        // kích thước bàn cờ theo toạ độ nội bộ
var scale = 1;
var builtW = 0, builtH = 0;            // khung nhìn tại thời điểm dựng bàn hiện tại

var mat = null;                        // ma trận giá trị
var cells = null;                      // ma trận phần tử DOM
var lines = [];                        // 3 vạch vẽ đường nối

var level = 1, blood = 10, score = 0, best = 0, remainPairs = 0, hintsLeft = 3;
var levelPairs = 0, pairsDone = 0, levelAwarded = 0;   // để chia đều 720 điểm cho số cặp của bàn
var gameStartTs = 0;                                   // mốc tính thời lượng ván, gửi kèm điểm
var firstSel = null, busy = false, gameOver = false;
var soundOn = true;
var sizeMode = 'auto';                 // 'auto' = vừa màn hình | 'full' = ép 16x9 như máy tính

var timeLimit = 0, timeLeft = 0, lastTs = 0, clockId = 0, clockOn = false;

/* ------------------------------------------------------------------- DOM */

var $ = function (id) { return document.getElementById(id); };
var stage, wrap, board, track, timebar, elLevel, elBlood, elScore, elBest, elHintLeft;
var elModal, elToast, toastTimer = 0;
var lastTimeText = '', lastColorStep = -1;

/* ==========================================================================
   Âm thanh — chỉ 4 file thật tồn tại; các tên còn thiếu tự động rơi về
   phương án dự phòng thay vì bắn 404 mỗi lần chơi như bản cũ.
   ========================================================================== */

/* Thư mục sound/ chỉ có 4 file thật: sound1, sound2, sound4, sound5.
   Bản cũ còn gọi sound7/sound8 (và mọi biến thể .ogg) vốn không tồn tại -> 404 liên tục.
   Nếu sau này bạn bổ sung file, chỉ cần thêm tên vào SOUND_FILES và đặt lên đầu
   danh sách tương ứng trong SOUND_MAP; các tên đứng sau là phương án dự phòng. */
var SOUND_FILES = ['sound1', 'sound2', 'sound4', 'sound5'];
var SOUND_MAP = {
    select: ['sound2'],
    match:  ['sound5', 'sound2'],
    wrong:  ['sound1'],
    start:  ['sound4'],
    lose:   ['sound1']
};
var audio = {}, audioUnlocked = false;

function initSound() {
    SOUND_FILES.forEach(function (n) {
        var rec = { el: new Audio('sound/' + n + '.mp3'), bad: false };
        rec.el.preload = 'auto';
        rec.el.addEventListener('error', function () { rec.bad = true; });
        audio[n] = rec;
    });
    try { soundOn = localStorage.getItem('pikachu.sound') !== '0'; } catch (e) {}
}

function play(kind) {
    if (!soundOn) return;
    var list = SOUND_MAP[kind] || [];
    for (var i = 0; i < list.length; i++) {
        var r = audio[list[i]];
        if (r && !r.bad) {
            try {
                r.el.currentTime = 0;
                var p = r.el.play();
                if (p && p.catch) p.catch(function () {});
            } catch (e) {}
            return;
        }
    }
}

/* iOS/Safari chặn phát âm thanh cho tới khi có thao tác người dùng đầu tiên */
function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    Object.keys(audio).forEach(function (k) {
        var r = audio[k];
        if (r.bad) return;
        try {
            var p = r.el.play();
            if (p && p.then) p.then(function () { r.el.pause(); r.el.currentTime = 0; }).catch(function () {});
        } catch (e) {}
    });
}

/* ==========================================================================
   Thuật toán bàn cờ (port từ bản gốc, tổng quát hoá theo COLS/ROWS)
   ========================================================================== */

function rnd(n) { return Math.floor(Math.random() * n); }

function newMatrix() {
    var a = new Array(MI), i, j;
    for (i = 0; i < MI; i++) { a[i] = new Array(MJ); for (j = 0; j < MJ; j++) a[i][j] = 0; }
    return a;
}

function Point(x, y) { this.x = x; this.y = y; }
function Rect(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; }
function inside(i, j) { return i >= 0 && i < MI && j >= 0 && j < MJ; }
function swap(a, i1, j1, i2, j2) { var t = a[i1][j1]; a[i1][j1] = a[i2][j2]; a[i2][j2] = t; }

function getNewMatrix() {
    var a = newMatrix();
    var total = COLS * ROWS, kinds = total / 4, remain = total;
    for (var k = 1; k <= kinds; k++) {
        for (var t = 0; t < 4; t++) {
            var key = rnd(remain--) + 1, placed = false;
            for (var i = 1; i <= COLS && !placed; i++) {
                for (var j = 1; j <= ROWS; j++) {
                    if (a[i][j] === 0 && --key === 0) { a[i][j] = k; placed = true; break; }
                }
            }
        }
    }
    return a;
}

/* BFS tối đa 2 lần rẽ — giữ nguyên logic bản gốc */
function checkPath(a, i1, j1, i2, j2) {
    if (i1 === i2 && j1 === j2) return null;
    if (a[i1][j1] === 0 || a[i2][j2] === 0) return null;
    if (a[i1][j1] !== a[i2][j2]) return null;

    var cap = MI * MJ + 4, queue = new Array(cap), i, j, t;
    for (i = 0; i < cap; i++) queue[i] = new Point(0, 0);

    var dad = new Array(MI), count = new Array(MI);
    for (i = 0; i < MI; i++) {
        dad[i] = new Array(MJ); count[i] = new Array(MJ);
        for (j = 0; j < MJ; j++) { dad[i][j] = new Point(-1, -1); count[i][j] = 0; }
    }

    var first = 0, last = 0;
    queue[0].x = i1; queue[0].y = j1;
    dad[i1][j1].x = -2;

    var canGo = [], p = [], q = [];
    while (first <= last) {
        i = queue[first].x; j = queue[first].y; first++;
        for (t = 0; t < 4; t++) { canGo[t] = true; p[t] = i; q[t] = j; }
        do {
            for (t = 0; t < 4; t++) {
                if (!canGo[t]) continue;
                p[t] += UU[t]; q[t] += VV[t];
                if (!inside(p[t], q[t])) { canGo[t] = false; continue; }
                if (p[t] === i2 && q[t] === j2) {
                    dad[p[t]][q[t]].x = i; dad[p[t]][q[t]].y = j;
                    return buildPath(dad, i2, j2);
                }
                if (a[p[t]][q[t]] > 0) { canGo[t] = false; continue; }
                if (dad[p[t]][q[t]].x !== -1) continue;
                if (count[i][j] === 2) continue;
                last++;
                queue[last].x = p[t]; queue[last].y = q[t];
                dad[p[t]][q[t]].x = i; dad[p[t]][q[t]].y = j;
                count[p[t]][q[t]] = count[i][j] + 1;
            }
        } while (canGo[0] || canGo[1] || canGo[2] || canGo[3]);
    }
    return null;
}

function buildPath(dad, i, j) {
    var list = [], p, q;
    do {
        list.push(new Point(i, j));
        p = dad[i][j].x; q = dad[i][j].y;
        i = p; j = q;
    } while (i !== -2);
    return list;
}

function findTwin(a, i1, j1) {
    var cap = MI * MJ + 4, queue = new Array(cap), i, j, t;
    for (i = 0; i < cap; i++) queue[i] = new Point(0, 0);

    var cx = new Array(MI), count = new Array(MI);
    for (i = 0; i < MI; i++) {
        cx[i] = new Array(MJ); count[i] = new Array(MJ);
        for (j = 0; j < MJ; j++) { cx[i][j] = true; count[i][j] = 0; }
    }

    var first = 0, last = 0;
    queue[0].x = i1; queue[0].y = j1;
    cx[i1][j1] = false;

    var canGo = [], p = [], q = [];
    while (first <= last) {
        i = queue[first].x; j = queue[first].y; first++;
        for (t = 0; t < 4; t++) { canGo[t] = true; p[t] = i; q[t] = j; }
        do {
            for (t = 0; t < 4; t++) {
                if (!canGo[t]) continue;
                p[t] += UU[t]; q[t] += VV[t];
                if (!inside(p[t], q[t])) { canGo[t] = false; continue; }
                if (a[p[t]][q[t]] === a[i1][j1] && cx[p[t]][q[t]]) return new Point(p[t], q[t]);
                if (a[p[t]][q[t]] > 0) { canGo[t] = false; continue; }
                if (!cx[p[t]][q[t]]) continue;
                if (count[i][j] === 2) continue;
                last++;
                queue[last].x = p[t]; queue[last].y = q[t];
                cx[p[t]][q[t]] = false;
                count[p[t]][q[t]] = count[i][j] + 1;
            }
        } while (canGo[0] || canGo[1] || canGo[2] || canGo[3]);
    }
    return null;
}

function isEnd(a) {
    for (var i = 1; i <= COLS; i++)
        for (var j = 1; j <= ROWS; j++)
            if (a[i][j] > 0 && findTwin(a, i, j) !== null) return false;
    return true;
}

function findCheat(a) {
    var b = [], c = [], k = 0, i, j;
    for (i = 1; i <= COLS; i++)
        for (j = 1; j <= ROWS; j++)
            if (a[i][j] > 0) { b[k] = i; c[k] = j; k++; }
    mixPair(b, c, k);
    for (i = 0; i < k - 1; i++)
        for (j = k - 1; j > i; j--)
            if (checkPath(a, b[i], c[i], b[j], c[j]) !== null)
                return new Rect(b[i], c[i], b[j], c[j]);
    return null;
}

function permutation(n) {
    var a = new Array(n), i, k, t;
    for (i = 0; i < n; i++) a[i] = n;
    var j = n;
    for (i = 0; i < n; i++) {
        k = rnd(j--) + 1; t = 0;
        while (k > 0) { if (a[t++] === n) k--; }
        a[t - 1] = i;
    }
    return a;
}

function mixArray(a, n) {
    var b = permutation(n), c = [], i;
    for (i = 0; i < n; i++) c[i] = a[b[i]];
    for (i = 0; i < n; i++) a[i] = c[i];
}

function mixPair(a, aa, n) {
    var b = permutation(n), c = [], i;
    for (i = 0; i < n; i++) c[i] = a[b[i]];
    for (i = 0; i < n; i++) a[i] = c[i];
    for (i = 0; i < n; i++) c[i] = aa[b[i]];
    for (i = 0; i < n; i++) aa[i] = c[i];
}

/* Xáo lại các quân còn sống, đảm bảo luôn tồn tại ít nhất một cặp đi được */
function repairMatrix(a) {
    var b = [], i, j, k = 0;
    for (i = 1; i <= COLS; i++)
        for (j = 1; j <= ROWS; j++)
            if (a[i][j] > 0) b[k++] = a[i][j];
    if (k < 2) return;

    mixArray(b, k);
    k = 0;
    for (i = 1; i <= COLS; i++)
        for (j = 1; j <= ROWS; j++)
            if (a[i][j] > 0) a[i][j] = b[k++];

    var tmp = newMatrix();
    for (i = 0; i < MI; i++)
        for (j = 0; j < MJ; j++)
            tmp[i][j] = a[i][j] > 0 ? 1 : 0;

    var rect = findCheat(tmp);
    if (!rect) return;

    var u = 0, v = 0, found = false;
    for (i = 1; i <= COLS && !found; i++) {
        for (j = 1; j <= ROWS; j++) {
            if ((i !== rect.x || j !== rect.y) && a[i][j] === a[rect.x][rect.y]) {
                u = i; v = j; found = true; break;
            }
        }
    }
    if (found) swap(a, rect.width, rect.height, u, v);
}

/* Trọng lực theo màn: từ màn 2 trở đi các quân bị dồn về một phía sau mỗi cặp */
function fixZone(a, i1, j1, i2, j2, vec) {
    var i, j, p, q, stop;
    do {
        stop = true;
        for (i = i1; i <= i2; i++) {
            for (j = j1; j <= j2; j++) {
                if (a[i][j] > 0) {
                    p = i + UU[vec]; q = j + VV[vec];
                    if (p >= 1 && p <= COLS && q >= 1 && q <= ROWS && a[p][q] === 0) {
                        swap(a, i, j, p, q); stop = false;
                    }
                }
            }
        }
    } while (!stop);
}

function fixMatrix(a, type) {
    var hc = Math.floor(COLS / 2), hr = Math.ceil(ROWS / 2);
    if (type === 1) return;
    if (type === 2)      fixZone(a, 1, 1, COLS, ROWS, 0);
    else if (type === 3) fixZone(a, 1, 1, COLS, ROWS, 1);
    else if (type === 4) fixZone(a, 1, 1, COLS, ROWS, 3);
    else if (type === 5) fixZone(a, 1, 1, COLS, ROWS, 2);
    else if (type === 6) { fixZone(a, 1, hr, COLS, ROWS, 0); fixZone(a, 1, 1, COLS, hr - 1, 1); }
    else if (type === 7) { fixZone(a, 1, hr, COLS, ROWS, 1); fixZone(a, 1, 1, COLS, hr - 1, 0); }
    else if (type === 8) { fixZone(a, 1, 1, hc, ROWS, 3); fixZone(a, hc + 1, 1, COLS, ROWS, 2); }
    else                 { fixZone(a, 1, 1, hc, ROWS, 2); fixZone(a, hc + 1, 1, COLS, ROWS, 3); }
}

/* ==========================================================================
   Dựng bàn cờ & hiển thị
   ========================================================================== */

function chooseSize() {
    if (sizeMode === 'full') return [16, 9];        // người chơi tự chọn bàn đầy đủ như máy tính

    /* #timeTrack nay la anh em cua #stage nen so do cua stage da tru san cho no */
    var aw = Math.max(stage.clientWidth, 120), ah = Math.max(stage.clientHeight, 120);

    var coarse = window.matchMedia('(pointer: coarse)').matches;
    var minPiece = coarse ? 30 : 24;                // ngón tay cần ô to hơn con trỏ chuột

    /* Trong số các bàn còn tap được, lấy bàn NHIỀU QUÂN NHẤT (không phải bàn đầu
       tiên vừa đủ) — nếu bằng nhau thì lấy bàn có ô to hơn. */
    var pick = null, pickCount = -1, pickSize = -1;
    var fallback = null, fallbackSize = -1;

    for (var n = 0; n < PRESETS.length; n++) {
        var c = PRESETS[n][0], r = PRESETS[n][1];
        var k = Math.min(aw / ((c + 2) * PW), ah / ((r + 2) * PH));
        var size = k * PW, count = c * r;

        if (size >= minPiece && (count > pickCount || (count === pickCount && size > pickSize))) {
            pick = PRESETS[n]; pickCount = count; pickSize = size;
        }
        if (size > fallbackSize) { fallbackSize = size; fallback = PRESETS[n]; }
    }
    return pick || fallback;
}

function buildBoard(cols, rows) {
    COLS = cols; ROWS = rows;
    MI = COLS + 2; MJ = ROWS + 2;
    BW = MI * PW; BH = MJ * PH;
    builtW = window.innerWidth; builtH = window.innerHeight;   // mốc so sánh cho relayout()

    board.textContent = '';
    lines = [];
    cells = new Array(MI);

    var frag = document.createDocumentFragment(), i, j;

    for (i = 0; i < 3; i++) {
        var ln = document.createElement('div');
        ln.className = 'line';
        lines.push(ln);
        frag.appendChild(ln);
    }

    for (i = 0; i < MI; i++) {
        cells[i] = new Array(MJ);
        for (j = 0; j < MJ; j++) cells[i][j] = null;
    }
    for (i = 1; i <= COLS; i++) {
        for (j = 1; j <= ROWS; j++) {
            var d = document.createElement('div');
            d.className = 'piece hidden';
            d.style.left = (i * PW) + 'px';
            d.style.top = (j * PH) + 'px';
            cells[i][j] = d;
            frag.appendChild(d);
        }
    }
    board.appendChild(frag);
    layout();
}

/* Gọi khi cửa sổ đổi kích thước hoặc xoay máy. Luôn co giãn lại; ngoài ra nếu
   cỡ bàn lý tưởng đã khác thì dựng lại bàn — nhưng CHỈ khi ván chưa bị đụng tới,
   để không xoá tiến độ của người đang chơi dở. */
function relayout() {
    layout();
    if (gameOver || busy || !mat || sizeMode === 'full') return;

    /* Ngưỡng trễ: chỉ xét dựng lại khi khung nhìn thật sự đổi đáng kể. Không có
       nó thì vài px xê dịch (font vừa tải xong, hàng nút xuống dòng) cũng đủ
       lật lựa chọn qua lại giữa hai cỡ bàn gần bằng nhau. */
    if (Math.abs(window.innerWidth - builtW) < 24 && Math.abs(window.innerHeight - builtH) < 24) return;

    var p = chooseSize();
    if (p[0] === COLS && p[1] === ROWS) { builtW = window.innerWidth; builtH = window.innerHeight; return; }
    if (remainPairs === COLS * ROWS / 2) startLevel();
}

function layout() {
    var aw = stage.clientWidth, ah = stage.clientHeight;

    scale = Math.min(aw / BW, ah / BH, MAX_SCALE);
    if (!isFinite(scale) || scale <= 0) scale = 1;

    board.style.width = BW + 'px';
    board.style.height = BH + 'px';
    board.style.transform = 'scale(' + scale + ')';

    var w = Math.round(BW * scale), h = Math.round(BH * scale);
    wrap.style.width = w + 'px';
    wrap.style.height = h + 'px';

    /* Thanh thời gian đặt vào dải viền trống của bàn cờ, ngay sát vùng ô cờ.
       Toạ độ tính theo VÙNG Ô CỜ chứ không theo #boardWrap: phần tử đó còn bao cả
       viền trống một ô mỗi bên (chỗ để đường nối chạy vòng ra ngoài), canh theo nó
       thì thanh thò ra hai bên đúng 2 ô. Định vị tuyệt đối nên không chiếm chỗ
       của bố cục -> không đụng tới số đo dùng để chọn cỡ bàn. */
    var tileX = PW * scale, tileY = PH * scale;      // mép trên-trái của vùng ô cờ; cũng là bề rộng dải viền

    /* Khoảng hở từ thanh tới hàng ô đầu tiên. Lấy ~45% bề rộng dải viền để thanh
       nằm cân giữa dải chứ không dán sát ô cờ, đồng thời vẫn thuộc về bàn cờ.
       Co theo tỉ lệ (bàn nhỏ thì hở ít) và luôn chừa chỗ cho chính bề dày thanh. */
    function gapIn(ring) {
        return Math.max(6, Math.min(30, Math.round(ring * 0.45), Math.round(ring - TRACK_THICK - 4)));
    }

    var vertical = window.matchMedia('(orientation: landscape) and (max-height: 560px)').matches;

    if (vertical) {
        track.style.left = Math.round(tileX - gapIn(tileX) - TRACK_THICK) + 'px';
        track.style.top = Math.round(tileY) + 'px';
        track.style.width = '';
        track.style.height = Math.round(ROWS * PH * scale) + 'px';
    } else {
        track.style.left = Math.round(tileX) + 'px';
        track.style.top = Math.round(tileY - gapIn(tileY) - TRACK_THICK) + 'px';
        track.style.width = Math.round(COLS * PW * scale) + 'px';
        track.style.height = '';
    }
}

function applyMatrix() {
    for (var i = 1; i <= COLS; i++) {
        for (var j = 1; j <= ROWS; j++) {
            var el = cells[i][j], v = mat[i][j];
            el.classList.remove('sel', 'hint');
            if (v === 0) {
                el.classList.add('hidden');
            } else {
                el.classList.remove('hidden');
                el.style.backgroundPosition = (-(v - 1) * IW) + 'px 0';
            }
        }
    }
    firstSel = null;
}

function centre(i, j) { return new Point(i * PW + PW / 2, j * PH + PH / 2); }

function segment(p1, p2) {
    var x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
    var y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
    return new Rect(x1 - 2, y1 - 2, x2 - x1 + 4, y2 - y1 + 4);
}

function drawPath(list) {
    var p1 = list[0], p2, r, i;
    for (i = 1; i < list.length && i <= 3; i++) {
        p2 = list[i];
        r = segment(centre(p1.x, p1.y), centre(p2.x, p2.y));
        var L = lines[i - 1];
        L.style.left = r.x + 'px';
        L.style.top = r.y + 'px';
        L.style.width = r.width + 'px';
        L.style.height = r.height + 'px';
        L.style.visibility = 'visible';
        p1 = p2;
    }
}

function hideLines() {
    for (var i = 0; i < lines.length; i++) lines[i].style.visibility = 'hidden';
}

/* ==========================================================================
   Vòng đời ván chơi
   ========================================================================== */

function updateHud() {
    elLevel.textContent = level;
    elBlood.textContent = blood;
    elScore.textContent = score;
    elBest.textContent = best;
}

/* Đổi tông nền mỗi ván mới — thay cho việc bốc ngẫu nhiên 1 trong 2 ảnh nền cũ. */
var THEME_COUNT = 5;

function pickTheme() {
    var b = document.body;
    for (var n = 1; n <= THEME_COUNT; n++) b.classList.remove('theme-' + n);
    b.classList.add('theme-' + (rnd(THEME_COUNT) + 1));
}

function newGame() {
    pickTheme();
    var p = chooseSize();
    if (!cells || p[0] !== COLS || p[1] !== ROWS) buildBoard(p[0], p[1]);
    level = 1; blood = 10; score = 0; gameOver = false;
    hintsLeft = HINT_MAX; updateHints();
    gameStartTs = Date.now();
    play('start');
    startLevel();
}

function startLevel() {
    var p = chooseSize();
    if (p[0] !== COLS || p[1] !== ROWS) buildBoard(p[0], p[1]);

    mat = getNewMatrix();
    remainPairs = COLS * ROWS / 2;
    levelPairs = remainPairs; pairsDone = 0; levelAwarded = 0;
    busy = false; firstSel = null;
    hideLines();
    applyMatrix();
    updateHud();

    timeLimit = COLS * ROWS * SEC_PER_PIECE;
    timeLeft = timeLimit;
    renderTime();
    startClock();
}

function afterMatch() {
    hideLines();

    /* Cộng theo tỉ lệ đã hoàn thành rồi trừ phần đã cộng: điểm luôn là số nguyên
       và ăn hết bàn thì tổng đúng bằng PTS_LEVEL, không lệch do làm tròn. */
    pairsDone++;
    var target = Math.round(PTS_LEVEL * pairsDone / levelPairs);
    score += target - levelAwarded;
    levelAwarded = target;

    remainPairs--;
    if (score > best) { best = score; saveBest(); }
    updateHud();

    if (remainPairs === 0) { stopClock(); busy = false; nextLevel(); return; }

    if (level > 1) { fixMatrix(mat, level); applyMatrix(); }
    busy = false;

    if (isEnd(mat)) deadlock();
}

function nextLevel() {
    var bonus = timeLimit > 0 ? Math.round(PTS_TIME * timeLeft / timeLimit) : 0;
    score += bonus;
    if (score > best) { best = score; saveBest(); }

    if (level >= LEVELS) {
        updateHud();
        gameOver = true;
        reportScore();
        showModal('🏆 Hoàn thành!', 'Bạn đã qua hết ' + LEVELS + ' bàn. Tổng điểm: <b>' + score + '</b>',
            [{ label: 'Chơi lại', fn: newGame }, { label: 'Đóng', ghost: true, fn: null }], true);
        return;
    }

    level++;
    blood++;
    updateHud();                       // cập nhật sau khi tăng, để HUD sau lưng hộp thoại không hiện số cũ
    showModal('Qua bàn ' + (level - 1), 'Thưởng thời gian: <b>+' + bonus + '</b> điểm.<br>Tổng điểm: <b>' + score + '</b>',
        [{ label: 'Bàn tiếp theo', fn: startLevel }]);
}

/* Gửi điểm lên bảng xếp hạng. Gọi ở cả ba đường kết thúc ván: hết giờ,
   hết lượt đổi, và hoàn thành 9 bàn. */
function reportScore() {
    if (!window.PikaLB) return;
    /* Không gửi ván 0 điểm. Hết giờ mà chưa ăn cặp nào thì chẳng có gì để xếp
       hạng, gửi lên chỉ làm bảng lúc mới mở đầy những dòng "0 điểm". */
    if (score <= 0) return;
    window.PikaLB.gameOver({
        score: score,
        level: level,
        cols: COLS,
        rows: ROWS,
        duration: Math.max(0, Math.round((Date.now() - gameStartTs) / 1000))
    });
}

function deadlock() {
    blood--;
    updateHud();
    if (blood <= 0) {
        stopClock();
        gameOver = true;
        play('lose');
        reportScore();
        showModal('Hết lượt đổi', 'Không còn cặp nào ghép được và bạn đã hết lượt đổi.<br>Điểm: <b>' + score + '</b>',
            [{ label: 'Chơi lại', fn: newGame }, { label: 'Đóng', ghost: true, fn: null }], true);
    } else {
        play('start');
        repairMatrix(mat);
        applyMatrix();
        toast('Không còn cặp nào — đã tự đổi vị trí (còn ' + blood + ' lượt)');
    }
}

function timeUp() {
    stopClock();
    gameOver = true;
    play('lose');
    reportScore();
    showModal('Hết giờ', 'Thời gian của bàn ' + level + ' đã hết.<br>Điểm: <b>' + score + '</b>',
        [{ label: 'Chơi lại', fn: newGame }, { label: 'Đóng', ghost: true, fn: null }], true);
}

/* ------------------------------------------------------------- đồng hồ (rAF) */

/* Một sắc duy nhất chuyển dần: đỏ (hết) -> hổ phách (nửa) -> lục (đầy). */
var T_STOPS = [[255, 90, 90], [255, 212, 38], [61, 220, 151]];

function timeColor(p) {
    var seg = p < .5 ? 0 : 1, t = p < .5 ? p / .5 : (p - .5) / .5;
    var a = T_STOPS[seg], b = T_STOPS[seg + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ','
                  + Math.round(a[1] + (b[1] - a[1]) * t) + ','
                  + Math.round(a[2] + (b[2] - a[2]) * t) + ')';
}

function renderTime() {
    var pct = timeLimit > 0 ? Math.max(0, timeLeft / timeLimit) : 0;
    timebar.style.setProperty('--pct', pct.toFixed(4));

    /* HUD không còn ô số thời gian (thanh đã nói đủ), nhưng vẫn giữ số phút:giây ở
       tooltip và nhãn trợ năng để ai cần con số chính xác thì rê chuột lên thanh. */
    var s = Math.max(0, Math.ceil(timeLeft));
    var txt = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    if (txt !== lastTimeText) {
        lastTimeText = txt;
        track.title = 'Thời gian còn lại ' + txt;
        track.setAttribute('aria-label', 'Thời gian còn lại ' + txt);
    }

    /* đổi màu theo từng bậc 2% để không phải ghi style mỗi nhịp */
    var step = Math.round(pct * 50);
    if (step !== lastColorStep) {
        lastColorStep = step;
        timebar.style.setProperty('--fill', timeColor(step / 50));
    }
}

/* Nhịp 250ms là đủ mượt cho một thanh đổi chậm, nhẹ pin hơn nhiều so với
   requestAnimationFrame (60 lần/giây) — đáng kể trên điện thoại.
   Thời gian trừ theo performance.now() nên không bị trôi dù nhịp bị nghẽn. */
var CLOCK_MS = 250;

function startClock() {
    lastTs = 0;
    clockOn = true;
    if (!clockId) clockId = setInterval(tick, CLOCK_MS);
}

function stopClock() {
    clockOn = false;
    if (clockId) { clearInterval(clockId); clockId = 0; }
}

function tick() {
    var ts = performance.now();
    if (!clockOn) { lastTs = ts; return; }
    if (!lastTs) { lastTs = ts; return; }

    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 1) dt = 1;                       // vừa quay lại tab: không trừ dồn một cục

    timeLeft -= dt;
    if (timeLeft <= 0) { timeLeft = 0; renderTime(); timeUp(); return; }
    renderTime();
}

/* ==========================================================================
   Tương tác
   ========================================================================== */

function select(i, j) {
    firstSel = { i: i, j: j };
    cells[i][j].classList.add('sel');
}

function clearSelect() {
    if (firstSel) cells[firstSel.i][firstSel.j].classList.remove('sel');
    firstSel = null;
}

function pick(i, j) {
    if (busy || gameOver || !mat) return;
    if (i < 1 || i > COLS || j < 1 || j > ROWS) return;
    if (mat[i][j] === 0) return;

    if (!firstSel) { play('select'); select(i, j); return; }

    if (firstSel.i === i && firstSel.j === j) { clearSelect(); return; }   // chạm lại để bỏ chọn

    var list = checkPath(mat, firstSel.i, firstSel.j, i, j);
    if (!list) {
        play('wrong');
        clearSelect();
        select(i, j);                                                     // chọn luôn quân vừa chạm
        return;
    }

    busy = true;
    play('match');
    var a = firstSel;
    clearSelect();
    mat[a.i][a.j] = 0; mat[i][j] = 0;
    cells[a.i][a.j].classList.remove('hint');
    cells[i][j].classList.remove('hint');
    cells[a.i][a.j].classList.add('hidden');
    cells[i][j].classList.add('hidden');
    drawPath(list);
    setTimeout(afterMatch, 200);
}

function onPointerDown(e) {
    unlockAudio();
    if (busy || gameOver) return;
    var r = board.getBoundingClientRect();
    var i = Math.floor((e.clientX - r.left) / (PW * scale));
    var j = Math.floor((e.clientY - r.top) / (PH * scale));
    if (i >= 1 && i <= COLS && j >= 1 && j <= ROWS) { e.preventDefault(); pick(i, j); }
}

function updateHints() {
    var b = $('btnHint');
    elHintLeft.textContent = hintsLeft;
    b.classList.toggle('spent', hintsLeft <= 0);
    b.title = hintsLeft > 0
        ? 'Gợi ý một cặp — còn ' + hintsLeft + '/' + HINT_MAX + ' lượt cho cả ván'
        : 'Đã dùng hết ' + HINT_MAX + ' lượt gợi ý của ván này';
}

function doHint() {
    if (busy || gameOver || !mat) return;
    if (hintsLeft <= 0) { toast('Hết lượt gợi ý — mỗi ván chỉ có ' + HINT_MAX + ' lượt'); return; }

    var old = board.querySelectorAll('.piece.hint');
    for (var n = 0; n < old.length; n++) old[n].classList.remove('hint');

    var rect = findCheat(mat);
    if (!rect) { toast('Không tìm được cặp nào'); return; }   // không tìm ra thì không trừ lượt

    hintsLeft--;
    updateHints();
    if (hintsLeft === 0) toast('Đây là lượt gợi ý cuối cùng của ván');

    var a = cells[rect.x][rect.y], b = cells[rect.width][rect.height];
    a.classList.add('hint'); b.classList.add('hint');
    setTimeout(function () { a.classList.remove('hint'); b.classList.remove('hint'); }, 1200);
}

function doShuffle() {
    if (busy || gameOver || !mat) return;
    if (blood <= 0) { toast('Bạn đã hết lượt đổi vị trí'); return; }
    blood--;
    play('start');
    repairMatrix(mat);
    applyMatrix();
    updateHud();
}

function doSize() {
    if (busy) return;
    var cur = COLS + '×' + ROWS;
    showModal('Cỡ bàn', 'Đang chơi bàn <b>' + cur + '</b>.<br>' +
        'Chế độ tự động chọn bàn lớn nhất mà ngón tay còn bấm chính xác được. ' +
        'Bàn đầy đủ 16×9 giống máy tính sẽ có ô nhỏ hơn nhiều trên điện thoại.<br>' +
        '<i>Đổi cỡ sẽ chơi lại bàn hiện tại, điểm và số bàn được giữ nguyên.</i>', [
        { label: 'Tự động', fn: function () { setSizeMode('auto'); } },
        { label: 'Đầy đủ 16×9', fn: function () { setSizeMode('full'); } },
        { label: 'Đóng', ghost: true, fn: null }
    ]);
}

function setSizeMode(m) {
    sizeMode = m;
    try { localStorage.setItem('pikachu.size', m); } catch (e) {}
    startLevel();                      // dựng lại bàn với cỡ mới, giữ điểm và số bàn
}

function doReplay() {
    showModal('Chơi lại?', 'Ván hiện tại sẽ bị huỷ và bắt đầu lại từ bàn 1.', [
        { label: 'Chơi lại', fn: newGame },
        { label: 'Tiếp tục', ghost: true, fn: null }
    ]);
}

function toggleSound() {
    soundOn = !soundOn;
    $('btnSound').classList.toggle('snd-on', soundOn);
    $('btnSound').classList.toggle('snd-off', !soundOn);
    try { localStorage.setItem('pikachu.sound', soundOn ? '1' : '0'); } catch (e) {}
    if (soundOn) play('select');
}

/* ------------------------------------------------------------- modal & toast */

function showModal(title, html, actions, withBoard) {
    var wasRunning = clockOn;
    clockOn = false;                                   // tạm dừng đồng hồ khi có hộp thoại

    $('mTitle').textContent = title;
    $('mText').innerHTML = html;

    var lb = $('mLb');
    lb.hidden = true;
    lb.innerHTML = '';
    if (withBoard && window.PikaLB) window.PikaLB.mount(lb);

    var acts = $('mActs');
    acts.textContent = '';
    actions.forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        if (a.ghost) b.className = 'ghost';
        b.addEventListener('click', function () {
            if (window.PikaLB) window.PikaLB.flush();  // chốt tên + gửi điểm dù người chơi bỏ qua ô nhập
            elModal.hidden = true;
            if (a.fn) a.fn();
            else if (wasRunning) { lastTs = 0; clockOn = true; }
        });
        acts.appendChild(b);
    });

    elModal.hidden = false;
    var first = acts.querySelector('button');
    if (first) first.focus();
}

function toast(msg) {
    elToast.textContent = msg;
    elToast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.hidden = true; }, 2200);
}

/* ------------------------------------------------------------------- lưu trữ */

function loadBest() {
    try { best = parseInt(localStorage.getItem('pikachu.best'), 10) || 0; } catch (e) { best = 0; }
}

function saveBest() {
    try { localStorage.setItem('pikachu.best', String(best)); } catch (e) {}
}

/* ==========================================================================
   Nạp tài nguyên & khởi động
   ========================================================================== */

function preload(srcs, onProgress) {
    return new Promise(function (resolve) {
        var done = 0, total = srcs.length;
        if (!total) return resolve();
        srcs.forEach(function (s) {
            var im = new Image();
            var fin = function () {
                done++;
                onProgress(done / total);
                if (done === total) resolve();
            };
            im.onload = fin;
            im.onerror = fin;
            im.src = s;
        });
    });
}

/* Không được chọn cỡ bàn khi trình duyệt còn báo kích thước bằng 0 (tab đang ẩn,
   viewport vừa đổi, bố cục chưa xong) — chọn sai lúc đó thì game kẹt với bàn bé
   xíu. Dùng setTimeout chứ không dùng requestAnimationFrame vì rAF không chạy
   khi tab bị ẩn, sẽ treo mãi. */
function whenSized(fn) {
    var tries = 0;
    (function check() {
        if ((stage.clientWidth > 80 && stage.clientHeight > 80) || ++tries > 40) return fn();
        setTimeout(check, 25);
    })();
}

function boot() {
    stage = $('stage'); wrap = $('boardWrap'); board = $('board');
    track = $('timeTrack'); timebar = $('timebar');
    elLevel = $('level'); elBlood = $('blood'); elScore = $('score'); elBest = $('best');
    elHintLeft = $('hintLeft');
    elModal = $('modal'); elToast = $('toast');


    /* Thang điểm đã đổi (chuẩn hoá theo bàn), kỷ lục cũ không so sánh được nữa
       nên xoá đúng một lần khi nâng cấp. */
    try {
        if (localStorage.getItem('pikachu.scoreVer') !== '2') {
            localStorage.removeItem('pikachu.best');
            localStorage.setItem('pikachu.scoreVer', '2');
        }
    } catch (e) {}

    loadBest();
    try { if (localStorage.getItem('pikachu.size') === 'full') sizeMode = 'full'; } catch (e) {}
    initSound();
    $('btnSound').classList.toggle('snd-on', soundOn);
    $('btnSound').classList.toggle('snd-off', !soundOn);

    wrap.addEventListener('pointerdown', onPointerDown);
    wrap.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    $('btnSound').addEventListener('click', toggleSound);
    $('btnShuffle').addEventListener('click', doShuffle);
    $('btnHint').addEventListener('click', doHint);
    $('btnSize').addEventListener('click', doSize);
    $('btnRank').addEventListener('click', function () { if (window.PikaLB) window.PikaLB.open(); });
    $('btnReplay').addEventListener('click', doReplay);

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') clearSelect();
        else if (e.key === 'h' || e.key === 'H') doHint();
    });

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) clockOn = false;
        else if (!gameOver && elModal.hidden && mat) { lastTs = 0; clockOn = true; }
    });

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(relayout, 120);
    });
    window.addEventListener('orientationchange', function () {
        setTimeout(relayout, 250);
    });

    /* Nền nay là gradient CSS nên không còn ảnh nào phải chờ ngoài sprite icon. */
    preload(['images/pieces-sprite.png'], function (p) { $('loadBar').style.width = (p * 100) + '%'; })
        .then(function () {
            $('loader').classList.add('done');
            setTimeout(function () { $('loader').style.display = 'none'; }, 320);
            whenSized(newGame);
        });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
