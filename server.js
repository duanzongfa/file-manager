const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 8765;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const USERS_FILE = path.join(__dirname, 'users.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sessions = new Map();

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }
let users = loadUsers();

function hashPwd(p) { return crypto.createHash('sha256').update(p).digest('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function getBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => resolve(d));
  });
}
function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function getUser(req) {
  const h = req.headers['authorization'];
  if (!h) return null;
  const t = h.replace('Bearer ', '');
  return sessions.has(t) ? sessions.get(t) : null;
}

function parseMultipart(body, boundary) {
  const sep = '\r\n--' + boundary;
  const parts = body.toString('latin1').split(sep);
  const files = [];
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    const he = trimmed.indexOf('\r\n\r\n');
    if (he === -1) continue;
    const hdr = trimmed.substring(0, he);
    const raw = part.substring(he + 4);
    const clean = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw;
    const dataBuf = Buffer.from(clean, 'latin1');
    const fm = hdr.match(/filename="([^"]+)"/i);
    if (!fm) continue;
    if (dataBuf.length > 0) files.push({ filename: fm[1], data: dataBuf });
  }
  return files;
}

// ── Build the HTML page ──
const HTML = buildHTML();

function buildHTML() {
  // The renderList function must generate onclick="downloadFile('filename')"
  // Inside the template literal, we use escaped single quotes:
  //   \\'  produces a literal ' in the output string
  // So: '...downloadFile(\\''+f.name+'\\')...' renders as:
  //   ...downloadFile(''+f.name+'')... which evaluates to:
  //   ...downloadFile('test.html')...
  
  // We'll use a helper to build the button HTML safely
  const scriptContent = `
const COLOR_MAP = {
  pdf:'#e74c3c', doc:'#3498db', docx:'#3498db', xls:'#27ae60', xlsx:'#27ae60',
  ppt:'#e67e22', pptx:'#e67e22', zip:'#9b59b6', rar:'#9b59b6',
  jpg:'#e91e63', jpeg:'#e91e63', png:'#e91e63', gif:'#e91e63', svg:'#e91e63', webp:'#e91e63',
  mp4:'#1abc9c', mov:'#1abc9c', avi:'#1abc9c',
  mp3:'#ff9800', wav:'#ff9800', flac:'#ff9800',
  txt:'#607d8b', md:'#607d8b', csv:'#607d8b'
};
let token = (typeof localStorage!=='undefined'?localStorage.getItem('fm_token'):null);
let currentUser = (typeof localStorage!=='undefined'?localStorage.getItem('fm_user'):null) || '';
let fileListData = [];

(async()=>{
  if(token){
    const r = await fetch('/api/me', {headers:{Authorization:'Bearer '+token}});
    if(r.ok){ showApp(); return; }
  }
  showLogin();
})();

function showLogin(){
  document.getElementById('loginScreen').style.display='block';
  document.getElementById('registerScreen').style.display='none';
  document.getElementById('appScreen').style.display='none';
  document.getElementById('loginErr').style.display='none';
  document.getElementById('loginUser').value='';
  document.getElementById('loginPwd').value='';
}
function showRegister(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('registerScreen').style.display='block';
  document.getElementById('appScreen').style.display='none';
  document.getElementById('regErr').style.display='none';
  document.getElementById('regOk').style.display='none';
  document.getElementById('regUser').value='';
  document.getElementById('regPwd').value='';
  document.getElementById('regPwd2').value='';
}
function showApp(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('registerScreen').style.display='none';
  document.getElementById('appScreen').style.display='block';
  document.getElementById('userName').textContent=currentUser;
  fetch('/api/addresses').then(r=>r.json()).then(addrs=>{
    const wrap=document.getElementById('localAddrs');
    wrap.innerHTML='';
    addrs.forEach(a=>{
      const el=document.createElement('a');
      el.className='addr'; el.href='#'; el.textContent=a;
      el.onclick=e=>{e.preventDefault();copyAddr(el,a);};
      wrap.appendChild(el);
    });
  });
  fetchFiles();
}

async function doLogin(){
  const u=document.getElementById('loginUser').value.trim();
  const p=document.getElementById('loginPwd').value;
  const err=document.getElementById('loginErr');
  if(!u||!p){err.textContent='请输入用户名和密码';err.style.display='block';return;}
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  const data=await r.json();
  if(r.ok){
    token=data.token; currentUser=data.username;
    try{localStorage.setItem('fm_token',token);}catch(e){}
    try{localStorage.setItem('fm_user',currentUser);}catch(e){}
    showApp();
  } else { err.textContent=data.error||'登录失败'; err.style.display='block'; }
}
async function doRegister(){
  const u=document.getElementById('regUser').value.trim();
  const p=document.getElementById('regPwd').value;
  const p2=document.getElementById('regPwd2').value;
  const err=document.getElementById('regErr');
  const ok=document.getElementById('regOk');
  err.style.display='none'; ok.style.display='none';
  if(!u||!p){err.textContent='请填写完整信息';err.style.display='block';return;}
  if(u.length<2||u.length>20){err.textContent='用户名需2-20个字符';err.style.display='block';return;}
  if(p.length<6){err.textContent='密码至少6位';err.style.display='block';return;}
  if(p!==p2){err.textContent='两次密码不一致';err.style.display='block';return;}
  const r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  const data=await r.json();
  if(r.ok){ok.textContent='注册成功！正在跳转登录…';ok.style.display='block';setTimeout(showLogin,1200);}
  else {err.textContent=data.error||'注册失败';err.style.display='block';}
}
function doLogout(){
  if(token) fetch('/api/logout',{method:'POST',headers:{Authorization:'Bearer '+token}}).catch(()=>{});
  token=null; currentUser='';
  try{localStorage.removeItem('fm_token');}catch(e){}
  try{localStorage.removeItem('fm_user');}catch(e){}
  showLogin();
}
function showErr(el,msg){el.textContent=msg;el.style.display='block';}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
function copyAddr(el,text){navigator.clipboard.writeText(text).then(()=>{const o=el.textContent;el.textContent='✓ 已复制';setTimeout(()=>el.textContent=o,1200);});}
function formatSize(b){if(!b)return'0 B';const u=['B','KB','MB','GB'];const i=Math.floor(Math.log(b)/Math.log(1024));return(b/Math.pow(1024,i)).toFixed(i===0?0:1)+' '+u[i];}
function getFileLabel(n){const e=n.split('.');return e.length>1?e[e.length-1].toUpperCase().slice(0,4):'FILE';}
function getFileColor(n){return COLOR_MAP[(n.split('.').pop()||'').toLowerCase()]||'#78909c';}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

async function fetchFiles(){
  const r=await fetch('/api/files',{headers:{Authorization:'Bearer '+token}});
  if(!r.ok){doLogout();return;}
  fileListData=await r.json();
  renderList();
}
function renderList(){
  const list=document.getElementById('fileList');
  const header=document.getElementById('listHeader');
  const empty=document.getElementById('emptyState');
  list.innerHTML='';
  fileListData.forEach(f=>{
    const li=document.createElement('li');
    li.className='file-item';
    // Use escape attribute to build safe onclick handlers
    // This produces: onclick="downloadFile('filename.html')"
    const onDownload = "downloadFile('" + f.name.replace(/'/g, "\\'") + "')";
    const onDelete = "deleteFile('" + f.name.replace(/'/g, "\\'") + "')";
    li.innerHTML=
      '<div class="file-icon" style="background:'+getFileColor(f.name)+'">'+getFileLabel(f.name)+'</div>'+
      '<div class="file-info"><div class="file-name" title="'+escHtml(f.name)+'">'+escHtml(f.name)+'</div>'+
      '<div class="file-size">'+formatSize(f.size)+'</div></div>'+
      '<div class="file-actions">'+
        '<button class="btn-download" onclick="'+onDownload+'">下载</button>'+
        '<button class="btn-delete" onclick="'+onDelete+'">删除</button>'+
      '</div>';
    list.appendChild(li);
  });
  const total=fileListData.length;
  header.style.display=total?'flex':'none';
  empty.style.display=total?'none':'';
  document.getElementById('fileCount').textContent=total;
}
function downloadFile(name){
  const a=document.createElement('a');
  a.href='/download/'+encodeURIComponent(name);
  a.download=name;
  document.body.appendChild(a);a.click();a.remove();
}
async function deleteFile(name){
  await fetch('/delete',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({name})});
  await fetchFiles();
  showToast('已删除: '+name);
}
document.getElementById('clearAllBtn').addEventListener('click',async()=>{
  if(!fileListData.length)return;
  if(!confirm('确认清空所有已上传的文件？'))return;
  await fetch('/delete-all',{method:'POST',headers:{Authorization:'Bearer '+token}});
  await fetchFiles();
  showToast('已清空全部文件');
});

function uploadFiles(files){
  const wrap=document.getElementById('progressWrap');
  const fill=document.getElementById('progressFill');
  const label=document.getElementById('progressLabel');
  wrap.style.display='block';
  fill.style.width='0%';
  label.textContent='准备上传…';
  const form=new FormData();
  files.forEach(f=>form.append('files',f));
  const xhr=new XMLHttpRequest();
  xhr.open('POST','/upload',true);
  xhr.setRequestHeader('Authorization','Bearer '+token);
  xhr.upload.onprogress=e=>{if(e.lengthComputable)fill.style.width=Math.round(e.loaded/e.total*90)+'%';};
  xhr.onload=function(){
    fill.style.width='100%';
    label.textContent='上传完成！';
    setTimeout(()=>wrap.style.display='none',1200);
    fetchFiles();
    showToast('成功上传 '+files.length+' 个文件');
  };
  xhr.onerror=function(){fill.style.width='0%';label.textContent='上传失败，请重试';setTimeout(()=>wrap.style.display='none',2000);};
  xhr.send(form);
}

const fileInput=document.getElementById('fileInput');
const uploadZone=document.getElementById('uploadZone');
fileInput.addEventListener('change',e=>{if(e.target.files.length)uploadFiles(e.target.files);});
uploadZone.addEventListener('dragover',e=>{e.preventDefault();uploadZone.classList.add('drag-over');});
uploadZone.addEventListener('dragleave',()=>uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop',e=>{
  e.preventDefault();uploadZone.classList.remove('drag-over');
  if(e.dataTransfer.files.length)uploadFiles(e.dataTransfer.files);
});
document.getElementById('loginPwd').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
document.getElementById('regPwd2').addEventListener('keydown',e=>{if(e.key==='Enter')doRegister();});
`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>文件管理器</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#f5f7fa; min-height:100vh; color:#1a1a2e; }
  .container { max-width:760px; margin:0 auto; padding:40px 24px; }
  h1 { font-size:24px; font-weight:600; margin-bottom:24px; text-align:center; }
  .auth-wrap { max-width:400px; margin:60px auto; }
  .auth-card { background:#fff; border-radius:12px; padding:32px; box-shadow:0 2px 8px rgba(0,0,0,.08); }
  .auth-card h2 { font-size:20px; font-weight:600; margin-bottom:20px; text-align:center; }
  .form-group { margin-bottom:16px; }
  .form-group label { display:block; font-size:13px; font-weight:500; color:#555; margin-bottom:6px; }
  .form-group input { width:100%; padding:10px 12px; border:1px solid #d0d7e2; border-radius:8px; font-size:14px; outline:none; transition:border-color .15s; }
  .form-group input:focus { border-color:#4f6ef7; }
  .btn-primary { width:100%; padding:11px; background:#4f6ef7; color:#fff; border:none; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; transition:background .15s; }
  .btn-primary:hover { background:#3b5ae0; }
  .auth-switch { text-align:center; margin-top:16px; font-size:13px; color:#888; }
  .auth-switch a { color:#4f6ef7; cursor:pointer; text-decoration:none; }
  .auth-switch a:hover { text-decoration:underline; }
  .error-msg { color:#e74c3c; font-size:13px; margin-top:8px; text-align:center; display:none; }
  .success-msg { color:#27ae60; font-size:13px; margin-top:8px; text-align:center; display:none; }
  .nav-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; }
  .nav-user { font-size:14px; color:#555; }
  .nav-user strong { color:#4f6ef7; }
  .btn-logout { font-size:13px; color:#e74c3c; background:none; border:1px solid #e74c3c; border-radius:6px; padding:4px 12px; cursor:pointer; }
  .btn-logout:hover { background:#fef0ef; }
  .server-bar { background:#1a1a2e; color:#c8d6e5; border-radius:10px; padding:14px 18px; margin-bottom:28px; font-size:13px; line-height:2; }
  .server-bar strong { color:#fff; }
  .server-bar .addr { display:inline-block; background:#2d3a4a; border-radius:5px; padding:2px 10px; font-family:monospace; color:#7bed9f; cursor:pointer; margin:2px 4px 2px 0; transition:background .15s; }
  .server-bar .addr:hover { background:#3d4f63; }
  .upload-zone { border:2px dashed #c0c8d8; border-radius:12px; padding:48px 24px; text-align:center; cursor:pointer; transition:border-color .2s,background .2s; background:#fff; position:relative; }
  .upload-zone:hover, .upload-zone.drag-over { border-color:#4f6ef7; background:#f0f3ff; }
  .upload-zone input[type=file] { position:absolute; inset:0; opacity:0; cursor:pointer; width:100%; height:100%; border-radius:12px; }
  .upload-icon { width:48px; height:48px; margin:0 auto 16px; color:#8fa3c4; }
  .upload-zone:hover .upload-icon, .upload-zone.drag-over .upload-icon { color:#4f6ef7; }
  .upload-text { font-size:15px; color:#555; }
  .upload-text span { color:#4f6ef7; font-weight:600; }
  .upload-hint { font-size:13px; color:#999; margin-top:6px; }
  .progress-wrap { display:none; margin-top:16px; }
  .progress-bar-bg { background:#e8ecf2; border-radius:6px; height:6px; overflow:hidden; }
  .progress-bar-fill { background:#4f6ef7; height:100%; width:0%; border-radius:6px; transition:width .3s; }
  .progress-label { font-size:12px; color:#888; margin-top:4px; text-align:center; }
  .file-list-header { display:flex; justify-content:space-between; align-items:center; margin-top:28px; margin-bottom:12px; }
  .file-list-header h2 { font-size:16px; font-weight:600; color:#333; }
  .clear-all-btn { font-size:13px; color:#e74c3c; background:none; border:1px solid #e74c3c; border-radius:6px; padding:4px 12px; cursor:pointer; }
  .clear-all-btn:hover { background:#fef0ef; }
  .file-list { list-style:none; display:flex; flex-direction:column; gap:8px; }
  .file-item { display:flex; align-items:center; gap:12px; background:#fff; border-radius:10px; padding:14px 16px; box-shadow:0 1px 3px rgba(0,0,0,.06); animation:fadeIn .25s ease; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
  .file-icon { width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:12px; font-weight:700; color:#fff; }
  .file-info { flex:1; min-width:0; }
  .file-name { font-size:14px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .file-size { font-size:12px; color:#888; margin-top:2px; }
  .file-actions { display:flex; gap:6px; flex-shrink:0; }
  .btn-download, .btn-delete { border:none; border-radius:6px; padding:6px 12px; font-size:13px; cursor:pointer; transition:background .15s; font-weight:500; }
  .btn-download { background:#4f6ef7; color:#fff; }
  .btn-download:hover { background:#3b5ae0; }
  .btn-delete { background:#f0f0f0; color:#666; }
  .btn-delete:hover { background:#e0e0e0; }
  .empty-state { text-align:center; padding:32px; color:#aaa; font-size:14px; }
  .toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:#1a1a2e; color:#fff; padding:10px 20px; border-radius:8px; font-size:14px; opacity:0; transition:opacity .3s; pointer-events:none; z-index:999; }
  .toast.show { opacity:1; }
</style>
</head>
<body><noscript><div style="padding:40px;text-align:center;background:#fff2f2;color:#c00;font-family:sans-serif;"><strong>请启用 JavaScript</strong>以使用文件管理器。</div></noscript>

<div id="loginScreen" class="auth-wrap" style="display:none;">
  <div class="auth-card">
    <h2>登录</h2>
    <div class="form-group"><label>用户名</label><input type="text" id="loginUser" placeholder="请输入用户名" autocomplete="username"></div>
    <div class="form-group"><label>密码</label><input type="password" id="loginPwd" placeholder="请输入密码" autocomplete="current-password"></div>
    <div class="error-msg" id="loginErr"></div>
    <button class="btn-primary" onclick="doLogin()">登 录</button>
    <div class="auth-switch">还没有账号？<a onclick="showRegister()">立即注册</a></div>
  </div>
</div>

<div id="registerScreen" class="auth-wrap" style="display:none;">
  <div class="auth-card">
    <h2>注册账号</h2>
    <div class="form-group"><label>用户名</label><input type="text" id="regUser" placeholder="设置用户名（2-20位）" autocomplete="username"></div>
    <div class="form-group"><label>密码</label><input type="password" id="regPwd" placeholder="设置密码（至少6位）" autocomplete="new-password"></div>
    <div class="form-group"><label>确认密码</label><input type="password" id="regPwd2" placeholder="再次输入密码" autocomplete="new-password"></div>
    <div class="error-msg" id="regErr"></div>
    <div class="success-msg" id="regOk"></div>
    <button class="btn-primary" onclick="doRegister()">注 册</button>
    <div class="auth-switch">已有账号？<a onclick="showLogin()">去登录</a></div>
  </div>
</div>

<div id="appScreen" class="container" style="display:none;">
  <h1>文件管理器</h1>
  <div class="nav-bar">
    <div class="nav-user">欢迎，<strong id="userName"></strong></div>
    <button class="btn-logout" onclick="doLogout()">退出登录</button>
  </div>
  <div class="server-bar">
    <strong>当前服务器地址</strong><br>
    <span>本机访问：</span><a class="addr" onclick="copyAddr(this,'http://localhost:8765')">http://localhost:8765</a><br>
    <span>局域网访问：</span><span id="localAddrs"><em style="color:#576b7e">加载中…</em></span>（点击可复制）<br>
  </div>
  <div class="upload-zone" id="uploadZone">
    <input type="file" id="fileInput" multiple>
    <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
    <div class="upload-text">点击或拖拽文件到此处上传</div>
    <div class="upload-hint">支持多选，需登录才能操作</div>
  </div>
  <div class="progress-wrap" id="progressWrap">
    <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressFill"></div></div>
    <div class="progress-label" id="progressLabel">上传中…</div>
  </div>
  <div class="file-list-header" id="listHeader" style="display:none;">
    <h2>已上传的文件（<span id="fileCount">0</span>）</h2>
    <button class="clear-all-btn" id="clearAllBtn">清空全部</button>
  </div>
  <ul class="file-list" id="fileList"></ul>
  <div class="empty-state" id="emptyState">暂无上传的文件</div>
</div>

<div class="toast" id="toast"></div>

<script>${scriptContent}</script>
</body>
</html>`;
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── Register ──
  if (url.pathname === '/api/register' && method === 'POST') {
    const body = await getBody(req);
    let data;
    try { data = JSON.parse(body); } catch { send(res, 400, { error: '请求格式错误' }); return; }
    const { username, password } = data;
    if (!username || !password) { send(res, 400, { error: '请填写用户名和密码' }); return; }
    if (username.length < 2 || username.length > 20) { send(res, 400, { error: '用户名需2-20个字符' }); return; }
    if (password.length < 6) { send(res, 400, { error: '密码至少6位' }); return; }
    if (users[username]) { send(res, 400, { error: '用户名已存在' }); return; }
    users[username] = hashPwd(password);
    saveUsers(users);
    send(res, 200, { ok: true });
    return;
  }

  // ── Login ──
  if (url.pathname === '/api/login' && method === 'POST') {
    const body = await getBody(req);
    let data;
    try { data = JSON.parse(body); } catch { send(res, 400, { error: '请求格式错误' }); return; }
    const { username, password } = data;
    if (!username || !password) { send(res, 400, { error: '请填写用户名和密码' }); return; }
    if (!users[username] || users[username] !== hashPwd(password)) { send(res, 401, { error: '用户名或密码错误' }); return; }
    const tok = genToken();
    sessions.set(tok, { username });
    send(res, 200, { token: tok, username });
    return;
  }

  // ── Logout ──
  if (url.pathname === '/api/logout' && method === 'POST') {
    const tok = req.headers['authorization']?.replace('Bearer ', '');
    if (tok) sessions.delete(tok);
    send(res, 200, { ok: true });
    return;
  }

  // ── Me ──
  if (url.pathname === '/api/me' && method === 'GET') {
    const u = getUser(req);
    if (!u) { send(res, 401, { error: '未登录' }); return; }
    send(res, 200, { username: u.username });
    return;
  }

  // ── API: files (requires auth) ──
  if (url.pathname === '/api/files' && method === 'GET') {
    const u = getUser(req);
    if (!u) { send(res, 401, { error: '请先登录' }); return; }
    try {
      const entries = fs.readdirSync(UPLOAD_DIR);
      const files = entries.map(name => {
        const stat = fs.statSync(path.join(UPLOAD_DIR, name));
        return { name, size: stat.size, modified: stat.mtimeMs };
      }).sort((a, b) => b.modified - a.modified);
      send(res, 200, files);
    } catch { send(res, 200, []); }
    return;
  }

  // ── LAN addresses ──
  if (url.pathname === '/api/addresses' && method === 'GET') {
    const ifaces = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name]) {
        if (info.family === 'IPv4' && !info.internal) addrs.push('http://' + info.address + ':' + PORT);
      }
    }
    addrs.push('http://localhost:' + PORT);
    send(res, 200, [...new Set(addrs)]);
    return;
  }

  // ── Upload (requires auth) ──
  if (url.pathname === '/upload' && method === 'POST') {
    const u = getUser(req);
    if (!u) { send(res, 401, { error: '请先登录' }); return; }
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/);
    if (!bm) { send(res, 400, { error: 'bad request' }); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const files = parseMultipart(body, bm[1]);
      let saved = 0;
      for (const f of files) {
        fs.writeFileSync(path.join(UPLOAD_DIR, f.filename), f.data);
        saved++;
      }
      console.log('[' + u.username + '] Upload: ' + files.length + ' files');
      send(res, 200, { ok: true, count: saved });
    });
    return;
  }

  // ── Download (requires auth) ──
  if (url.pathname.startsWith('/download/') && method === 'GET') {
    const u = getUser(req);
    if (!u) { send(res, 401, { error: '请先登录' }); return; }
    const filename = path.basename(decodeURIComponent(url.pathname.slice('/download/'.length)));
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) { send(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ── Delete (requires auth) ──
  if (url.pathname === '/delete' && method === 'POST') {
    const u = getUser(req);
    if (!u) { send(res, 401, { error: '请先登录' }); return; }
    const body = await getBody(req);
    let data;
    try { data = JSON.parse(body); } catch { send(res, 400, { error: '请求格式错误' }); return; }
    const filePath = path.join(UPLOAD_DIR, data.name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.log('[' + u.username + '] Delete: ' + data.name);
    send(res, 200, { ok: true });
    return;
  }

  // ── Delete all (requires auth) ──
  if (url.pathname === '/delete-all' && method === 'POST') {
    const u = getUser(req);
    if (!u) { send(res, 401, { error: '请先登录' }); return; }
    const entries = fs.readdirSync(UPLOAD_DIR);
    for (const name of entries) fs.unlinkSync(path.join(UPLOAD_DIR, name));
    console.log('[' + u.username + '] Delete all');
    send(res, 200, { ok: true });
    return;
  }

  // ── Serve HTML ──
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  console.log('');
  console.log('========================================');
  console.log('  文件管理器 v2.0（带登录）已启动');
  console.log('  端口: ' + PORT);
  console.log('----------------------------------------');
  const localAddrs = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name]) {
      if (info.family === 'IPv4' && !info.internal) localAddrs.push('  ' + info.address);
    }
  }
  if (localAddrs.length > 0) {
    console.log('  局域网地址（其他设备访问）:');
    localAddrs.forEach(a => console.log(a));
  } else {
    console.log('  ⚠ 未检测到局域网地址，仅本机可访问');
  }
  console.log('  本机地址: http://localhost:' + PORT);
  console.log('========================================');
  console.log('提示: 确保防火墙允许 ' + PORT + ' 端口入站连接');
  console.log('按 Ctrl+C 停止服务器');
  console.log('');
});
