// 境途同游 V7.11 — 签到卡片增强（彩带特效 / 本周签到条）
// checkin.js 负责数据与主渲染；本文件只挂视觉增强，独立成文件便于回滚。
class CheckinExtra {
  constructor() {
    this.confettiTimer = null;
  }

  // 签到成功时的彩带雨：纯 DOM + CSS transition，无第三方库
  celebrateCheckin(count) {
    const total = count || 36;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let host = document.getElementById('checkin-confetti');
    if (!host) {
      host = document.createElement('div');
      host.id = 'checkin-confetti';
      document.body.appendChild(host);
    }
    // 重复触发时先清掉上一批，避免粒子越积越多
    host.innerHTML = '';

    const colors = ['#7c5cfc', '#fbbf24', '#10b981', '#ef4444', '#38bdf8', '#ec4899'];
    for (let i = 0; i < total; i++) {
      const p = document.createElement('span');
      p.className = 'confetti-piece';
      p.style.left = Math.random() * 100 + 'vw';
      p.style.background = colors[i % colors.length];
      p.style.transform = `rotate(${Math.floor(Math.random() * 360)}deg)`;
      if (Math.random() > 0.5) p.classList.add('round');
      const duration = 1800 + Math.random() * 1400; // ms
      const delay = Math.random() * 250;
      host.appendChild(p);
      requestAnimationFrame(() => {
        p.style.transition = `top ${duration}ms ease-in ${delay}ms, transform ${duration}ms linear ${delay}ms`;
        p.style.top = '105vh';
        p.style.transform = `translateX(${(Math.random() - 0.5) * 240}px) rotate(${360 + Math.floor(Math.random() * 720)}deg)`;
      });
    }

    if (this.confettiTimer) clearTimeout(this.confettiTimer);
    this.confettiTimer = setTimeout(() => { host.innerHTML = ''; }, duration_ms(total));
  }
}

function duration_ms(count) {
  return Math.min(6000, 2400 + count * 30);
}

const checkinExtra = new CheckinExtra();
window.checkinExtra = checkinExtra;
