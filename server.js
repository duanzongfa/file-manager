const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8765;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Multipart parser ──
// Body format: --boundary\r\nheaders\r\n\r\ndata\r\n--boundary--\r\n
// Note: NO leading \r\n before the first boundary (unlike file upload POST)
function parseMultipart(body, boundary) {
  const sep = '--' + boundary;
  const bodyStr = body.toString('latin1');
  const parts = bodyStr.split(sep);
  const files = [];
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    // Skip end markers like "--"
    if (part.trim() === '--' || part.trim() === '') continue;
    const trimmed = part.trim();
    if (!trimmed) continue;
    const headerEnd = trimmed.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerBlock = trimmed.substring(0, headerEnd);
    const rawBodyStart = headerEnd + 4;
    const rawData = part.substring(rawBodyStart);
    const cleanData = rawData.endsWith('\r\n') ? rawData.slice(0, -2) : rawData;
    const dataBuf = Buffer.from(cleanData, 'latin1');
    const cdMatch = headerBlock.match(/filename="([^"]+)"/i);
    if (!cdMatch) continue;
    if (dataBuf.length > 0) files.push({ filename: cdMatch[1], data: dataBuf });
  }
  return files;
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>文件管理器</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f7fa; min-height: 100vh; color: #1a1a2e; }
  .container { max-width: 760px; margin: 0 auto; padding: 40px 24px; }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 24px; text-align: center; }
  .server-bar { background: #1a1a2e; color: #c8d6e5; border-radius: 10px; padding: 14px 18px; margin-bottom: 28px; font-size: 13px; line-height: 2; }
  .server-bar strong { color: #fff; }
  .server-bar .addr { display: inline-block; background: #2d3a4a; border-radius: 5px; padding: 2px 10px; font-family: monospace; color: #7bed9f; cursor: pointer; margin: 2px 4px 2px 0; transition: background .15s; }
  .server-bar .addr:hover { background: #3d4f63; }
  .upload-zone { border: 2px dashed #c0c8d8; border-radius: 12px; padding: 48px 24px; text-align: center; cursor: pointer; transition: border-color .2s, background .2s; background: #fff; position: relative; }
  .upload-zone:hover, .upload-zone.drag-over { border-color: #4f6ef7; background: #f0f3ff; }
  .upload-zone input[type="file"] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; border-radius: 12px; }
  .upload-icon { width: 48px; height: 48px; margin: 0 auto 16px; color: #8fa3c4; }
  .upload-zone:hover .upload-icon, .upload-zone.drag-over .upload-icon { color: #4f6ef7; }
  .upload-text { font-size: 15px; color: #555; }
  .upload-text span { color: #4f6ef7; font-weight: 600; }
  .upload-hint { font-size: 13px; color: #999; margin-top: 6px; }
  .progress-wrap { display: none; margin-top: 16px; }
  .progress-bar-bg { background: #e8ecf2; border-radius: 6px; height: 6px; overflow: hidden; }
  .progress-bar-fill { background: #4f6ef7; height: 100%; width: 0%; border-radius: 6px; transition: width .3s; }
  .progress-label { font-size: 12px; color: #888; margin-top: 4px; text-align: center; }
  .file-list-header { display: flex; justify-content: space-between; align-items: center; margin-top: 28px; margin-bottom: 12px; }
  .file-list-header h2 { font-size: 16px; font-weight: 600; color: #333; }
  .clear-all-btn { font-size: 13px; color: #e74c3c; background: none; border: 1px solid #e74c3c; border-radius: 6px; padding: 4px 12px; cursor: pointer; transition: background .2s; }
  .clear-all-btn:hover { background: #fef0ef; }
  .file-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
  .file-item { display: flex; align-items: center; gap: 12px; background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.06); animation: fadeIn .25s ease; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
  .file-icon { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 12px; font-weight: 700; color: #fff; }
  .file-info { flex: 1; min-width: 0; }
  .file-name { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .file-size { font-size: 12px; color: #888; margin-top: 2px; }
  .file-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .btn-download, .btn-delete { border: none; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; transition: background .15s; font-weight: 500; }
  .btn-download { background: #4f6ef7; color: #fff; }
  .btn-download:hover { background: #3b5ae0; }
  .btn-delete { background: #f0f0f0; color: #666; }
  .btn-delete:hover { background: #e0e0e0; }
  .empty-state { text-align: center; padding: 32px; color: #aaa; font-size: 14px; }
</style>
</head>
<body>
<div class="container">
  <h1>文件管理器</h1>
  <div class="server-bar" id="serverBar">
    <strong>当前服务器地址</strong><br>
    <span>本机访问：</span><a class="addr" onclick="copyAddr(this,'http://localhost:8765')">http://localhost:8765</a><br>
    <span>局域网访问：</span><span id="localAddrs"><em style="color:#576b7e">加载中…</em></span>（点击地址可复制）<br>
  </div>
  <div class="upload-zone" id="uploadZone">
    <input type="file" id="fileInput" multiple>
    <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
    <div class="upload-text">点击或拖拽文件到此处上传</div>
    <div class="upload-hint">支持多选，从另一台电脑打开此页面即可操作</div>
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
<script>
const COLOR_MAP = {
  pdf:'#e74c3c', doc:'#3498db', docx:'#3498db', xls:'#27ae60', xlsx:'#27ae60',
  ppt:'#e67e22', pptx:'#e67e22', zip:'#9b59b6', rar:'#9b59b6',
  jpg:'#e91e63', jpeg:'#e91e63', png:'#e91e63', gif:'#e91e63', svg:'#e91e63', webp:'#e91e63',
  mp4:'#1abc9c', mov:'#1abc9c', avi:'#1abc9c',
  mp3:'#ff9800', wav:'#ff9800', flac:'#ff9800',
  txt:'#607d8b', md:'#607d8b', csv:'#607d8b'
};
function getExt(name){ const p=name.split('.'); return p.length>1?p[p.length-1].toLowerCase():''; }
function formatSize(b){ if(!b)return'0 B'; const u=['B','KB','MB','GB']; const i=Math.floor(Math.log(b)/Math.log(1024)); return(b/Math.pow(1024,i)).toFixed(i===0?0:1)+' '+u[i]; }
function getFileLabel(name){ const ext=getExt(name); return ext?ext.toUpperCase().slice(0,4):'FILE'; }
function getFileColor(name){ return COLOR_MAP[getExt(name)]||'#78909c'; }
function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

fetch('/api/addresses').then(r=>r.json()).then(addrs=>{
  const wrap=document.getElementById('localAddrs');
  wrap.innerHTML='';
  addrs.forEach(a=>{
    const el=document.createElement('a');
    el.className='addr';
    el.href='#';
    el.textContent=a;
    el.onclick=e=>{ e.preventDefault(); copyAddr(el,a); };
    wrap.appendChild(el);
  });
});

function copyAddr(el, text){
  navigator.clipboard.writeText(text).then(()=>{
    const orig=el.textContent;
    el.textContent='✓ 已复制';
    setTimeout(()=>el.textContent=orig, 1200);
  });
}

let fileListData=[];
async function fetchFiles(){
  const r=await fetch('/api/files');
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
    li.innerHTML=
      '<div class="file-icon" style="background:'+getFileColor(f.name)+'">'+getFileLabel(f.name)+'</div>'+
      '<div class="file-info"><div class="file-name" title="'+escHtml(f.name)+'">'+escHtml(f.name)+'</div>'+
      '<div class="file-size">'+formatSize(f.size)+'</div></div>'+
      '<div class="file-actions">'+
        '<button class="btn-download" onclick="downloadFile(\'\'+'+escHtml(f.name)+'+\'')">下载</button>'+
        '<button class="btn-delete" onclick="deleteFile(\'\'+'+escHtml(f.name)+'+\'')">删除</button>'+
      '</div>';
    list.appendChild(li);
  });
  const total=fileListData.length;
  header.style.display=total?'flex':'none';
  empty.style.display=total?'none':'';
  document.getElementById('fileCount').textContent=total;
}
function downloadFile(name){ window.open('/download/'+encodeURIComponent(name)); }
async function deleteFile(name){
  await fetch('/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
  await fetchFiles();
}
document.getElementById('clearAllBtn').addEventListener('click',async()=>{
  if(!fileListData.length)return;
  if(!confirm('确认清空所有已上传的文件？'))return;
  await fetch('/delete-all',{method:'POST'});
  await fetchFiles();
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
  xhr.upload.onprogress=e=>{
    if(e.lengthComputable) fill.style.width=Math.round(e.loaded/e.total*90)+'%';
  };
  xhr.onload=function(){
    fill.style.width='100%';
    label.textContent='上传完成！';
    setTimeout(()=>wrap.style.display='none',1200);
    fetchFiles();
  };
  xhr.onerror=function(){
    fill.style.width='0%';
    label.textContent='上传失败，请重试';
    setTimeout(()=>wrap.style.display='none',2000);
  };
  xhr.send(form);
}

const fileInput=document.getElementById('fileInput');
const uploadZone=document.getElementById('uploadZone');
fileInput.addEventListener('change',e=>{ if(e.target.files.length) uploadFiles(e.target.files); });
uploadZone.addEventListener('dragover',e=>{ e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave',()=>uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop',e=>{
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  if(e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

fetchFiles();
setInterval(fetchFiles, 5000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (url.pathname === '/api/files' && method === 'GET') {
    try {
      const entries = fs.readdirSync(UPLOAD_DIR);
      const files = entries.map(name => {
        const stat = fs.statSync(path.join(UPLOAD_DIR, name));
        return { name, size: stat.size, modified: stat.mtimeMs };
      }).sort((a, b) => b.modified - a.modified);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(files));
    } catch (e) { res.writeHead(500); res.end('[]'); }
    return;
  }

  if (url.pathname === '/api/addresses' && method === 'GET') {
    const ifaces = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name]) {
        if (info.family === 'IPv4' && !info.internal) addrs.push('http://' + info.address + ':' + PORT);
      }
    }
    addrs.push('http://localhost:' + PORT);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify([...new Set(addrs)]));
    return;
  }

  if (url.pathname === '/upload' && method === 'POST') {
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/);
    if (!bm) { res.writeHead(400); res.end('bad request'); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const files = parseMultipart(body, bm[1]);
      console.log('Upload: body=' + body.length + 'B boundary=' + bm[1] + ' files=' + files.length);
      let saved = 0;
      for (const f of files) {
        const filePath = path.join(UPLOAD_DIR, f.filename);
        fs.writeFileSync(filePath, f.data);
        saved++;
        console.log('  Saved: ' + f.filename + ' (' + f.data.length + 'B)');
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, count: saved }));
    });
    return;
  }

  if (url.pathname.startsWith('/download/') && method === 'GET') {
    const filename = path.basename(decodeURIComponent(url.pathname.slice('/download/'.length)));
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (url.pathname === '/delete' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        const filePath = path.join(UPLOAD_DIR, name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (url.pathname === '/delete-all' && method === 'POST') {
    try {
      const entries = fs.readdirSync(UPLOAD_DIR);
      for (const name of entries) fs.unlinkSync(path.join(UPLOAD_DIR, name));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch { res.writeHead(500); res.end(); }
    return;
  }

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
  console.log('  文件管理器服务器已启动');
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
