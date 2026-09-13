
function showDbSection() {
  if (!currentUser || (currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  const section = document.getElementById('adminDatabaseSection');
  if (section) {
    section.classList.remove('d-none');
    initDbEventDelegates();
    switchDbTab('status');
  }
}

function initDbEventDelegates() {
  const container = document.getElementById('adminDatabaseSection');
  if (!container || container._dbDelegateInit) return;
  container._dbDelegateInit = true;
  
  container.addEventListener('click', (e) => {
    const el = e.target.closest('[data-db-action], [data-action]');
    if (!el) return;
    
    if (el.hasAttribute('data-db-action')) {
      const action = el.dataset.dbAction;
      const value = el.dataset.dbValue;
      
      switch (action) {
        case 'show-table':
          showDbTableDetail(value);
          break;
        case 'kill-process':
          dbKillProcess(parseInt(value));
          break;
      }
    } else if (el.hasAttribute('data-action')) {
      const action = el.dataset.action;
      const value = parseInt(el.dataset.value);
      
      switch (action) {
        case 'page-click':
          loadDbTablePage(value);
          break;
        case 'index-page':
          loadDbIndexPage(value);
          break;
        case 'record-page':
          loadDbRecordPage(value);
          break;
      }
    }
  });
}

function checkDbPermission() {
  if (currentUser && (currentUser.role === 'super_admin')) {
    showDbSection();
  }
}

// ==================== 管理员 - 数据库管理模块 ====================

let currentDbTable = null;
let currentDbTablePage = 1;
let dbTablesData = [];
let dbTableSearchTimer = null;

function switchDbTab(tabName) {
  if (!currentUser || (currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  document.querySelectorAll('[data-dbtab]').forEach(btn => {
    btn.classList.remove('btn-accent');
    btn.classList.add('btn-outline');
    if (btn.dataset.dbtab === tabName) {
      btn.classList.remove('btn-outline');
      btn.classList.add('btn-accent');
    }
  });

  document.querySelectorAll('.db-tab-content').forEach(content => {
    content.classList.add('d-none');
  });

  const targetContent = document.getElementById(`db${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Content`);
  if (targetContent) {
    targetContent.classList.remove('d-none');
  }

  if (tabName === 'status') {
    loadDbStatus();
    loadDbVariables();
  } else if (tabName === 'tables') {
    loadDbTables();
  } else if (tabName === 'processes') {
    loadDbProcesses();
  } else if (tabName === 'slow') {
    loadDbSlowQueries();
  }
}

async function loadDbStatus() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  try {
    const res = await api('/api/admin/db/status', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        document.getElementById('dbStatConnected').textContent = data.connected ? '🟢 ' + __('admin.db_connected_yes') : '🔴 ' + __('admin.db_connected_no');
        document.getElementById('dbStatConnected').classList.remove('skeleton-stat');
        
        document.getElementById('dbStatVersion').textContent = data.version;
        document.getElementById('dbStatVersion').classList.remove('skeleton-stat');
        
        const uptime = data.uptime;
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        document.getElementById('dbStatUptime').textContent = days > 0 ? __('admin.db_uptime_days', {days, hours}) : __('admin.db_uptime_hours', {hours, minutes});
        document.getElementById('dbStatUptime').classList.remove('skeleton-stat');
        
        document.getElementById('dbStatConnections').textContent = `${data.activeConnections}/${data.connections}`;
        document.getElementById('dbStatConnections').classList.remove('skeleton-stat');
        
        document.getElementById('dbStatQueries').textContent = formatNumber(data.queries);
        document.getElementById('dbStatQueries').classList.remove('skeleton-stat');
        
        const pool = data.poolStats;
        document.getElementById('dbStatPool').textContent = `${pool.activeConnections || 0}/${pool.connectionLimit || 0}`;
        document.getElementById('dbStatPool').classList.remove('skeleton-stat');
        
        if (pool) {
          document.getElementById('dbPoolLimit').textContent = pool.connectionLimit || '-';
          document.getElementById('dbPoolActive').textContent = pool.activeConnections || '-';
          document.getElementById('dbPoolIdle').textContent = pool.idleConnections || '-';
          document.getElementById('dbPoolWaiting').textContent = pool.waitingCount || '-';
        }
      } else {
        document.getElementById('dbStatConnected').textContent = '🔴 ' + data.error;
        document.getElementById('dbStatConnected').classList.remove('skeleton-stat');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.load_failed') + ': ' + err.message, 'error');
  }
}

async function loadDbVariables() {
  try {
    const res = await api('/api/admin/db/variables', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        const container = document.getElementById('dbVariables');
        container.innerHTML = data.variables.map(v => `
          <div>
            <div class="text-12 text-muted2">${esc(v.name)}</div>
            <div class="text-13 font-semibold">${esc(formatSize(parseInt(v.value)) || v.value)}</div>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
  }
}

async function loadDbTables() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  try {
    const res = await api('/api/admin/db/tables', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        dbTablesData = data.tables;
        renderDbTables(dbTablesData);
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.load_tables_failed') + ': ' + err.message, 'error');
  }
}

function onDbTableSearch(value) {
  clearTimeout(dbTableSearchTimer);
  dbTableSearchTimer = setTimeout(() => {
    const search = value.toLowerCase().trim();
    const filtered = dbTablesData.filter(t => t.name.toLowerCase().includes(search));
    renderDbTables(filtered);
  }, 300);
}

function renderDbTables(tables) {
  const container = document.getElementById('dbTablesList');
  if (!container) return;
  
  if (tables.length === 0) {
    container.innerHTML = `<p class="text-muted2">${__('ui.no_data')}</p>`;
    return;
  }
  
  container.innerHTML = tables.map(t => `
    <div class="admin-user-card" data-db-action="show-table" data-db-value="${escAttr(t.name)}">
      <div style="flex:1">
        <div style="font-weight:600">${esc(t.name)}</div>
        <div class="text-12 text-muted2">${esc(t.engine)} · ${t.rows} ${__('admin.db_rows')} · ${formatSize(t.totalSize)}</div>
      </div>
      <div style="text-align:right">
        <div class="text-12 text-muted2">${esc(t.collation)}</div>
        <div class="text-12 text-muted2">${t.columns.length} ${__('admin.db_cols')}</div>
      </div>
    </div>
  `).join('');
}

async function showDbTableDetail(tableName) {
  currentDbTable = tableName;
  currentDbTablePage = 1;
  
  document.getElementById('dbTableName').textContent = tableName;
  document.getElementById('dbTableDetail').classList.remove('d-none');
  
  try {
    const res = await api(`/api/admin/db/table/${tableName}`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        document.getElementById('dbTableEngine').textContent = data.engine;
        document.getElementById('dbTableRows').textContent = data.rows;
        document.getElementById('dbTableDataSize').textContent = formatSize(data.dataSize);
        document.getElementById('dbTableIndexSize').textContent = formatSize(data.indexSize);
        
        renderDbTableColumns(data.columns);
        renderDbTableIndexes(data.indexes);
        renderDbTableRecords(data.records, data.total, data.page, data.totalPages);
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.load_table_failed') + ': ' + err.message, 'error');
  }
}

function hideDbTableDetail() {
  document.getElementById('dbTableDetail').classList.add('d-none');
  currentDbTable = null;
}

function renderDbTableColumns(columns) {
  const container = document.getElementById('dbTableColumns');
  if (!container) return;
  
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:var(--bg2)">
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_col_name')}</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_col_type')}</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_col_null')}</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_col_key')}</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_col_default')}</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_col_extra')}</th>
        </tr>
      </thead>
      <tbody>
        ${columns.map(c => `
          <tr style="border-bottom:1px solid var(--border-light)">
            <td style="padding:8px;font-size:13px">${esc(c.name)}</td>
            <td style="padding:8px;font-size:13px">${esc(c.type)}</td>
            <td style="padding:8px;font-size:13px">${c.nullable ? 'YES' : 'NO'}</td>
            <td style="padding:8px;font-size:13px">${esc(c.key || '-')}</td>
            <td style="padding:8px;font-size:13px">${esc(c.default !== undefined ? c.default : '-')}</td>
            <td style="padding:8px;font-size:13px">${esc(c.extra || '-')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderDbTableIndexes(indexes) {
  const container = document.getElementById('dbTableIndexes');
  if (!container) return;
  
  if (indexes.length === 0) {
    container.innerHTML = `<p class="text-muted2">${__('admin.db_no_indexes')}</p>`;
    return;
  }
  
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:var(--bg2)">
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_idx_name')}</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_idx_type')}</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_idx_cols')}</th>
        </tr>
      </thead>
      <tbody>
        ${indexes.map(i => `
          <tr style="border-bottom:1px solid var(--border-light)">
            <td style="padding:8px;font-size:13px">${i.name || 'PRIMARY'}</td>
            <td style="padding:8px;font-size:13px">${i.type}</td>
            <td style="padding:8px;font-size:13px">${i.columns.join(', ')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderDbTableRecords(records, total, page, totalPages) {
  const container = document.getElementById('dbTableRecords');
  const pagination = document.getElementById('dbTablePagination');
  if (!container || !pagination) return;
  
  if (records.length === 0) {
    container.innerHTML = `<p class="text-muted2">${__('ui.no_data')}</p>`;
    pagination.innerHTML = '';
    return;
  }
  
  const columns = Object.keys(records[0]);
  
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:var(--bg2)">
          ${columns.map(c => `<th style="padding:6px 8px;text-align:left;font-size:11px;font-weight:600;border-bottom:1px solid var(--border)">${c}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${records.map(row => `
          <tr style="border-bottom:1px solid var(--border-light)">
            ${columns.map(c => {
              const raw = row[c];
              let val;
              if (raw === null) {
                val = '<span style="color:var(--muted2)">NULL</span>';
              } else if (typeof raw === 'object') {
                val = esc(JSON.stringify(raw));
              } else if (typeof raw === 'boolean') {
                val = esc(raw ? 'true' : 'false');
              } else {
                val = esc(String(raw));
              }
              return `<td style="padding:6px 8px;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(String(raw === null ? 'NULL' : raw))}">${val}</td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  
  pagination.innerHTML = renderPagination(page, totalPages, 'page-click');
}

async function loadDbTablePage(page) {
  if (!currentDbTable) return;
  currentDbTablePage = page;
  
  try {
    const res = await api(`/api/admin/db/table/${currentDbTable}?page=${page}`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        renderDbTableRecords(data.records, data.total, data.page, data.totalPages);
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.load_table_failed') + ': ' + err.message, 'error');
  }
}

async function dbOptimizeTable() {
  if (!currentDbTable) return;
  if (!confirm(__('admin.db.confirm_optimize', {table: currentDbTable}))) return;
  
  try {
    const res = await api(`/api/admin/db/optimize/${currentDbTable}`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        toast(data.message, 'success');
        loadDbTables();
        showDbTableDetail(currentDbTable);
      } else {
        toast(data.error, 'error');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.optimize_failed') + ': ' + err.message, 'error');
  }
}

async function dbAnalyzeTable() {
  if (!currentDbTable) return;
  
  try {
    const res = await api(`/api/admin/db/analyze/${currentDbTable}`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        toast(data.message, 'success');
      } else {
        toast(data.error, 'error');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.analyze_failed') + ': ' + err.message, 'error');
  }
}

async function dbCheckTable() {
  if (!currentDbTable) return;
  
  try {
    const res = await api(`/api/admin/db/check/${currentDbTable}`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        const results = data.result.map(r => `${r.Msg_type}: ${r.Msg_text}`).join('\n');
        alert(__('admin.db.check_result') + '\n\n' + results);
      } else {
        toast(data.error, 'error');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.check_failed') + ': ' + err.message, 'error');
  }
}

async function dbRepairTable() {
  if (!currentDbTable) return;
  if (!confirm(__('admin.db.confirm_repair', {table: currentDbTable}))) return;
  
  try {
    const res = await api(`/api/admin/db/repair/${currentDbTable}`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        const results = data.result.map(r => `${r.Msg_type}: ${r.Msg_text}`).join('\n');
        alert(__('admin.db.repair_result') + '\n\n' + results);
        loadDbTables();
        showDbTableDetail(currentDbTable);
      } else {
        toast(data.error, 'error');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.repair_failed') + ': ' + err.message, 'error');
  }
}

async function loadDbProcesses() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  try {
    const res = await api('/api/admin/db/processlist', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        const container = document.getElementById('dbProcessesList');
        if (!container) return;
        
        if (data.processes.length === 0) {
          container.innerHTML = `<p class="text-muted2">${__('admin.db_no_processes')}</p>`;
          return;
        }
        
        container.innerHTML = `
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:var(--bg2)">
                <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">PID</th>
                <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_proc_user')}</th>
                <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_proc_host')}</th>
                <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_proc_db')}</th>
                <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_proc_command')}</th>
                <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_proc_time')}</th>
                <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_proc_state')}</th>
                <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)">${__('admin.db_proc_action')}</th>
              </tr>
            </thead>
            <tbody>
              ${data.processes.map(p => `
                <tr style="border-bottom:1px solid var(--border-light)">
                  <td style="padding:8px;font-size:13px;font-weight:600">${p.id}</td>
                  <td style="padding:8px;font-size:13px">${p.user}</td>
                  <td style="padding:8px;font-size:13px">${p.host}</td>
                  <td style="padding:8px;font-size:13px">${p.db}</td>
                  <td style="padding:8px;font-size:13px">${p.command}</td>
                  <td style="padding:8px;font-size:13px">${p.time}s</td>
                  <td style="padding:8px;font-size:13px">${p.state || '-'}</td>
                  <td style="padding:8px;font-size:13px">
                    <button data-db-action="kill-process" data-db-value="${p.id}" class="btn btn-sm btn-red" style="padding:2px 8px">${__('admin.db_kill')}</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div class="text-12 text-muted2 mt-4">${__('admin.db_total_processes')}: ${data.total}</div>
        `;
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.load_processes_failed') + ': ' + err.message, 'error');
  }
}

async function dbKillProcess(pid) {
  if (!confirm(__('admin.db.confirm_kill', {pid}))) return;
  
  try {
    const res = await api(`/api/admin/db/kill/${pid}`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        toast(data.message, 'success');
        loadDbProcesses();
      } else {
        toast(data.error, 'error');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.kill_failed') + ': ' + err.message, 'error');
  }
}

async function loadDbSlowQueries() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  try {
    const res = await api('/api/admin/db/slow-queries', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        const container = document.getElementById('dbSlowStats');
        if (!container) return;
        
        container.innerHTML = `
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div class="stat-card"><div class="stat-value ${data.slowQueryCount > 0 ? 'stat-value-warning' : 'stat-value-success'}">${data.slowQueryCount}</div><div class="stat-label">${__('admin.db_slow_count_label')}</div></div>
            <div class="stat-card"><div class="stat-value">${data.slowLogEnabled ? '🟢 ' + __('admin.db_slow_enabled') : '🔴 ' + __('admin.db_slow_disabled')}</div><div class="stat-label">${__('admin.db_slow_log_label')}</div></div>
          </div>
          <div class="mt-8 p-8" style="background:var(--card2);border-radius:8px">
            <h5 class="text-13 font-medium mb-3" data-i18n="admin.db_slow_file">日志文件</h5>
            <div class="text-13" style="word-break:break-all">${data.slowLogFile || '-'}</div>
          </div>
        `;
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.db.load_slow_failed') + ': ' + err.message, 'error');
  }
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function renderPagination(current, total, actionType) {
  if (total <= 1) return '';
  
  let html = '';
  const maxVisible = 5;
  let start = Math.max(1, current - Math.floor(maxVisible / 2));
  let end = Math.min(total, start + maxVisible - 1);
  
  if (end - start + 1 < maxVisible) {
    start = Math.max(1, end - maxVisible + 1);
  }
  
  if (start > 1) {
    html += `<button data-action="${actionType}" data-value="1" class="btn btn-sm btn-outline">1</button>`;
    if (start > 2) {
      html += `<span class="text-12 text-muted2 mx-2">...</span>`;
    }
  }
  
  for (let i = start; i <= end; i++) {
    html += `<button data-action="${actionType}" data-value="${i}" class="btn btn-sm ${i === current ? 'btn-accent' : 'btn-outline'}">${i}</button>`;
  }
  
  if (end < total) {
    if (end < total - 1) {
      html += `<span class="text-12 text-muted2 mx-2">...</span>`;
    }
    html += `<button data-action="${actionType}" data-value="${total}" class="btn btn-sm btn-outline">${total}</button>`;
  }
  
  return html;
}
