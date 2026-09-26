(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BombSfx = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  /**
   * كل المؤثرات الصوتية هنا مولَّدة برمجيًا بالكامل عبر Web Audio API (نغمات/ضوضاء بسيطة)،
   * وليست ملفات صوتية خارجية - هذا يضمن عدم وجود أي إشكال متعلق بحقوق أي مصدر صوتي،
   * ولا يتطلب أي اتصال إنترنت أو تحميل أصول إضافية (خفيف تمامًا من ناحية الأداء).
   */

  let ctx = null;
  function getCtx() {
    if (typeof window === 'undefined') return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(freq, startOffset, duration, opts) {
    opts = opts || {};
    const c = getCtx();
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, c.currentTime + startOffset);
    if (opts.sweepTo) {
      osc.frequency.linearRampToValueAtTime(opts.sweepTo, c.currentTime + startOffset + duration);
    }
    const peak = opts.volume != null ? opts.volume : 0.18;
    gain.gain.setValueAtTime(0.0001, c.currentTime + startOffset);
    gain.gain.exponentialRampToValueAtTime(peak, c.currentTime + startOffset + Math.min(0.02, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + startOffset + duration);
    osc.connect(gain).connect(c.destination);
    osc.start(c.currentTime + startOffset);
    osc.stop(c.currentTime + startOffset + duration + 0.02);
  }

  function noiseBurst(startOffset, duration, opts) {
    opts = opts || {};
    const c = getCtx();
    if (!c) return;
    const bufferSize = Math.max(1, Math.floor(c.sampleRate * duration));
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = c.createBufferSource();
    src.buffer = buffer;
    const gain = c.createGain();
    gain.gain.setValueAtTime(opts.volume != null ? opts.volume : 0.12, c.currentTime + startOffset);
    src.connect(gain).connect(c.destination);
    src.start(c.currentTime + startOffset);
  }

  const SOUNDS = {
    // نقرة قصيرة عامة (اختيار/تأكيد بسيط)
    tap() { tone(520, 0, 0.06, { type: 'square', volume: 0.1 }); },
    // بداية الجولة: نغمة صاعدة قصيرة تعطي إحساس انطلاق
    start() {
      tone(220, 0, 0.12, { type: 'sawtooth', sweepTo: 440, volume: 0.16 });
      tone(440, 0.12, 0.15, { type: 'sine', volume: 0.14 });
    },
    // تمرير القنبلة: "تك" قصير مع صدى بسيط
    pass() {
      tone(300, 0, 0.07, { type: 'square', volume: 0.13 });
      tone(300, 0.08, 0.05, { type: 'square', volume: 0.06 });
    },
    // ظهور حدث ديناميكي مفاجئ
    event() {
      tone(700, 0, 0.09, { type: 'triangle', sweepTo: 900, volume: 0.15 });
      tone(500, 0.1, 0.09, { type: 'triangle', sweepTo: 650, volume: 0.12 });
    },
    // الدخول في "اللحظة الحرجة" - تحذير واضح
    criticalWarning() {
      tone(880, 0, 0.1, { type: 'square', volume: 0.18 });
      tone(880, 0.15, 0.1, { type: 'square', volume: 0.18 });
      tone(880, 0.3, 0.14, { type: 'square', volume: 0.2 });
    },
    // نزع فتيل ناجح: نغمة مريحة صاعدة
    defuseSuccess() {
      tone(440, 0, 0.1, { type: 'sine', volume: 0.15 });
      tone(660, 0.1, 0.14, { type: 'sine', volume: 0.16 });
    },
    // خروج لاعب: نغمة هابطة + ضوضاء قصيرة
    eliminate() {
      tone(300, 0, 0.18, { type: 'sawtooth', sweepTo: 90, volume: 0.2 });
      noiseBurst(0.02, 0.2, { volume: 0.1 });
    },
    // إعلان الفائز: نغمات احتفالية صاعدة
    winner() {
      [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.12, 0.18, { type: 'triangle', volume: 0.18 }));
    },
  };

  function play(name) {
    if (SOUNDS[name]) {
      try { SOUNDS[name](); } catch (e) { /* لا نكسر اللعبة أبدًا بسبب فشل صوتي */ }
    }
  }

  return { play };
});
