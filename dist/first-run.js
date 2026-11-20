const $ = id => document.getElementById(id);

export function initSetupUI(refreshStatus, toast, beforeQuit = () => {}) {
  let active = false, starting = false, lastPhase = '';
  let planRequest = 0;
  let approvedPlan = null;
  const body = () => ({ backend: $('setup-backend').value, runtimeDir: $('setup-directory').value.trim() });
  const planKey = () => new URLSearchParams(body()).toString();
  const updateControls = () => {
    const locked = active || starting;
    $('setup-start').disabled = locked || approvedPlan !== planKey();
    for (const id of ['setup-backend', 'setup-directory', 'setup-check']) $(id).disabled = locked;
  };
  const request = async (url, options) => {
    const response = await fetch(url, options); const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Installation request failed.');
    return data;
  };
  const showPlan = async () => {
    const requestId = ++planRequest;
    const key = planKey();
    approvedPlan = null;
    updateControls();
    $('setup-plan').textContent = '正在检查硬件与磁盘空间…';
    try {
      const plan = await request('/api/setup/plan?' + key);
      if (requestId !== planRequest || key !== planKey()) return;
      $('setup-plan').textContent = `${plan.backend.toUpperCase()} · ${(plan.downloadBytes / 1048576).toFixed(1)} MiB download\n${plan.runtimeDir}\n${[...plan.explanations, ...plan.errors].join('\n')}`;
      if (!plan.errors.length) approvedPlan = key;
    } catch (error) {
      if (requestId !== planRequest || key !== planKey()) return;
      $('setup-plan').textContent = error.message;
    }
    updateControls();
  };
  const poll = async () => {
    try {
      const status = await request('/api/setup/status');
      active = status.running;
      updateControls();
      $('setup-progress').textContent = active ? '正在安装，请稍候…' : status.phase === 'completed' ? '安装完成，可以开始对弈。' : status.phase === 'failed' ? '安装失败，请查看日志或选择 CPU 重试。' : '安装尚未开始。';
      $('setup-log').textContent = status.log + (status.error ? `\n${status.error}` : '');
      if (status.phase !== lastPhase && ['completed', 'failed'].includes(status.phase)) await refreshStatus();
      lastPhase = status.phase;
    } catch { /* The app may have been closed by the user. */ }
    if (active) setTimeout(poll, 1000);
  };
  $('setup-check').addEventListener('click', showPlan);
  $('setup-backend').addEventListener('change', showPlan);
  $('setup-directory').addEventListener('input', updateControls);
  $('setup-directory').addEventListener('change', showPlan);
  $('setup-start').addEventListener('click', async () => {
    if (active || starting || approvedPlan !== planKey()) return;
    starting = true;
    updateControls();
    try {
      await request('/api/setup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
      active = true;
    } catch (error) {
      toast(error.message);
    } finally {
      starting = false;
      updateControls();
      await poll();
    }
  });
  $('quit-app').addEventListener('click', async () => {
    try {
      await beforeQuit();
      await request('/api/desktop/quit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast('应用已关闭，可以关闭此页面。');
    }
    catch (error) { toast(error.message); }
  });
  return {
    update(status) {
      $('quit-app').hidden = !status.desktop;
      $('setup-panel').hidden = status.installed && !status.error && !status.setupRunning;
      if (!$('setup-panel').hidden && !lastPhase) { lastPhase = 'initial'; showPlan(); poll(); }
    },
  };
}
