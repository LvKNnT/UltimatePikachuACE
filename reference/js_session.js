/* Định danh máy, cố định qua các lần chơi.
   Dùng để bảng xếp hạng gộp mọi ván của cùng một người thành một dòng, và để
   sinh tên mặc định không trùng nhau ("Người chơi #A7F3"). */
var PIKA_SESSION = (function () {
    'use strict';
    var KEY = 'pikachu.sid';
    var sid = '';

    try { sid = localStorage.getItem(KEY) || ''; } catch (e) { sid = ''; }

    if (!/^[0-9a-f]{12,}$/.test(sid)) {
        sid = Date.now().toString(16) + Math.random().toString(16).slice(2, 10) +
              Math.random().toString(16).slice(2, 6);
        try { localStorage.setItem(KEY, sid); } catch (e) { /* chế độ riêng tư: dùng tạm trong phiên */ }
    }
    return sid;
})();
