import {api} from './api.js';
import {escapeHtml,showToast} from './utils.js';
import {openSheet} from './sheet.js';

let timer=null;
const html=escapeHtml;

function editFolder(folder,onSaved){
 const sheet=openSheet({title:folder.relativePath?'修改文件夹名称':'添加子目录',size:'md',content:`<div class="space-y-4 text-sm"><p class="break-all text-tg-textSecondary">${html(folder.path)}</p><label class="block">分类名称<input data-name class="tg-input w-full mt-2" maxlength="80" value="${html(folder.name)}"></label><p class="text-tg-textSecondary">只导入这个目录及其内部的媒体，其他同级目录不会导入。</p><p data-error class="text-red-400" role="alert"></p><button data-save class="tg-btn px-4 py-2 w-full">${folder.relativePath?'保存名称':'添加到媒体库'}</button></div>`});
 const save=sheet.root.querySelector('[data-save]');
 const input=sheet.root.querySelector('[data-name]');
 save.addEventListener('click',async()=>{
  save.disabled=true;
  try{
   await api.post('/api/library/folders',{path:folder.relativePath||folder.path,name:input.value.trim()});
   sheet.close();showToast('已保存，正在更新媒体索引');await showLocalFoldersPage();await onSaved?.();
  }catch(error){sheet.root.querySelector('[data-error]').textContent=error.message;save.disabled=false}
 });
 input.focus();input.select();
}

function browseFolders(){
 let current='';let requestId=0;
 const sheet=openSheet({title:'选择要添加的子目录',size:'lg',content:`<div class="space-y-3 text-sm"><p class="text-tg-textSecondary">进入大目录，手动添加需要的子目录。每个添加的目录会单独显示为一个分类。</p><div class="flex gap-2 items-center"><button data-up class="tg-btn-secondary px-3 py-2 shrink-0">上一级</button><span data-path class="break-all font-medium"></span></div><label class="block">筛选当前目录<input data-filter class="tg-input w-full mt-1" placeholder="输入目录名称"></label><div data-current class="bg-tg-bg rounded-lg p-3"></div><p data-error class="text-red-400" role="alert"></p><div data-directories class="space-y-2" style="max-height:45vh;overflow:auto"></div></div>`});
 const root=sheet.root;
 const filter=root.querySelector('[data-filter]');
 const refresh=async(p=current)=>{
  const token=++requestId;
  root.querySelector('[data-error]').textContent='';
  root.querySelector('[data-directories]').textContent='正在读取目录…';
  try{
   const data=await api.get('/api/library/folders/browse?path='+encodeURIComponent(p));
   if(token!==requestId||!root.isConnected)return;
   current=data.path;root.querySelector('[data-path]').textContent=current||'已挂载的大目录';
   root.querySelector('[data-up]').disabled=!current;
   filter.value='';
   const currentPanel=root.querySelector('[data-current]');
   currentPanel.innerHTML=current.includes('/')?`<div class="flex flex-wrap gap-2 justify-between items-center"><span class="break-all">当前目录：${html(current.split('/').pop())}</span><button data-add-current class="tg-btn px-3 py-2">添加此目录</button></div>`:'<p class="text-tg-textSecondary">请选择大目录里面的子目录，不会自动导入整个大目录。</p>';
   currentPanel.querySelector('[data-add-current]')?.addEventListener('click',()=>editFolder({path:current,name:current.split('/').pop()},()=>refresh()));
   const list=root.querySelector('[data-directories]');
   list.innerHTML=(data.directories||[]).map((dir,i)=>`<div data-directory="${i}" class="flex gap-2 items-center border border-tg-border rounded-lg p-2"><button data-open="${i}" class="text-left min-w-0 flex-1 px-2 py-2 break-all"><i class="ri-folder-line mr-2"></i>${html(dir.name)} <span class="text-tg-textSecondary">›</span></button>${dir.path.includes('/')?`<button data-add="${i}" class="tg-btn-secondary shrink-0 px-3 py-2" ${dir.selected?'disabled':''}>${dir.selected?'已添加':'添加'}</button>`:''}</div>`).join('')||'<p class="py-6 text-center text-tg-textSecondary">此目录没有可选择的子目录。</p>';
   list.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>refresh(data.directories[Number(button.dataset.open)].path)));
   list.querySelectorAll('[data-add]').forEach(button=>button.addEventListener('click',()=>{const dir=data.directories[Number(button.dataset.add)];editFolder(dir,()=>refresh())}));
  }catch(error){if(token!==requestId)return;root.querySelector('[data-error]').textContent=error.message;root.querySelector('[data-directories]').textContent=''}
 };
 root.querySelector('[data-up]').addEventListener('click',()=>refresh(current.split('/').slice(0,-1).join('/')));
 filter.addEventListener('input',()=>root.querySelectorAll('[data-directory]').forEach(row=>{row.style.display=row.textContent.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())?'':'none'}));
 refresh();
}

function removeFolder(folder){
 const sheet=openSheet({title:'移除媒体分类',size:'md',content:`<div class="space-y-4 text-sm"><p>从媒体库移除「${html(folder.name)}」？</p><p class="text-tg-textSecondary">仅移除该目录的媒体索引和收藏关联，NAS 中的原文件保持不变。之后可以重新添加。</p><p data-error class="text-red-400" role="alert"></p><button data-remove class="tg-btn px-4 py-2">移除分类</button></div>`});
 const button=sheet.root.querySelector('[data-remove]');
 button.addEventListener('click',async()=>{button.disabled=true;try{await api.post('/api/library/folders/remove',{path:folder.relativePath});sheet.close();showToast('已移除分类，原文件未改动');await showLocalFoldersPage()}catch(error){sheet.root.querySelector('[data-error]').textContent=error.message;button.disabled=false}});
}

export function destroy(){if(timer)clearTimeout(timer);timer=null}
export async function showLocalFoldersPage(){
 destroy();let page=document.getElementById('page-local-folders');
 if(!page){page=document.createElement('div');page.id='page-local-folders';page.className='max-w-6xl mx-auto px-3 sm:px-4 pb-24';document.getElementById('content-area').appendChild(page)}
 try{
  const result=await api.get('/api/library/folders');const status=result.status||{};
  const folders=result.folders||[];const auto=result.autoScan||{enabled:true,intervalMinutes:5,settleSeconds:60};
  page.innerHTML=`<a href="#/settings" class="inline-flex items-center gap-1 text-sm text-tg-textSecondary mb-4"><i class="ri-arrow-left-line" aria-hidden="true"></i>返回设置</a><div class="flex flex-wrap gap-3 items-center justify-between mb-5"><div><h2 class="text-xl font-semibold">本地文件夹</h2><p class="text-sm text-tg-textSecondary">手动添加大目录中的子目录，按目录分别管理媒体。</p></div><div class="flex gap-2"><button data-add-folder class="tg-btn px-3 py-2">添加子目录</button><button data-scan-folders class="tg-btn-secondary px-3 py-2" ${status.running?'disabled':''}>${status.running?'正在扫描…':'重新扫描'}</button></div></div><form data-auto-scan-form class="bg-tg-panel rounded-xl p-4 mb-4 space-y-3 text-sm"><h3 class="font-semibold">自动同步目录</h3><label class="flex items-center gap-2"><input data-auto-enabled type="checkbox" ${auto.enabled?'checked':''}>启用定时扫描</label><div class="flex flex-wrap gap-4"><label>扫描间隔（分钟）<input data-auto-interval type="number" min="1" max="1440" required class="tg-input block mt-1" value="${Number(auto.intervalMinutes)||5}"></label><label>文件稳定等待（秒）<input data-auto-settle type="number" min="0" max="3600" required class="tg-input block mt-1" value="${Number(auto.settleSeconds)||0}"></label></div><p class="text-tg-textSecondary">只同步已添加的分类及其子目录；跳过常见下载临时文件，并等待文件停止写入。扫描不会重叠执行。</p><p>下一次扫描：${auto.enabled?(auto.nextScanAt?html(new Date(auto.nextScanAt).toLocaleString('zh-CN',{hour12:false})):'正在安排…'):'已关闭'}</p><p data-auto-error class="text-red-400" role="alert">${html(auto.error||'')}</p><button type="submit" class="tg-btn px-4 py-2">保存扫描设置</button></form><div class="bg-tg-panel rounded-xl p-4 mb-4 text-sm"><p>只有手动添加的目录会出现在媒体库。各分类包含所选目录及其内部的媒体。</p><p class="mt-2 text-tg-textSecondary">挂载的大目录仅供浏览，原文件不会被移动或复制。</p><p class="mt-2" role="status">${status.error?html(status.error):status.running?'正在更新已添加目录的媒体索引…':status.finishedAt?`上次扫描：${new Date(status.finishedAt).toLocaleString('zh-CN',{hour12:false})}；识别 ${Number(status.indexed)||0} 个文件，更新 ${Number(status.changed)||0} 项，${Number(status.errors)||0} 项错误。`:'点击“添加子目录”开始选择。'}</p></div><div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${folders.map((folder,i)=>`<div class="bg-tg-panel border border-tg-border rounded-xl p-4"><a class="block hover:text-tg-link" href="#/viewer/${encodeURIComponent(folder.groupId)}"><div class="font-medium"><i class="ri-folder-video-line mr-2"></i>${html(folder.name)}</div><div class="text-sm text-tg-textSecondary mt-2">${Number(folder.count)||0} 个媒体文件</div><div class="text-xs text-tg-textSecondary mt-1 break-all">${html(folder.relativePath)}</div></a><div class="flex gap-3 mt-3"><button data-rename="${i}" class="tg-btn-secondary px-3 py-1" ${status.running?'disabled':''}>改名</button><button data-remove="${i}" class="tg-btn-secondary px-3 py-1" ${status.running?'disabled':''}>移除</button></div></div>`).join('')||'<div class="text-tg-textSecondary py-12 text-center">尚未添加子目录。点击“添加子目录”，浏览大目录并选择需要的分类。</div>'}</div>`;
  const autoForm=page.querySelector('[data-auto-scan-form]');
  autoForm.addEventListener('input',()=>{autoForm.dataset.dirty='true'});
  autoForm.addEventListener('submit',async(event)=>{
   event.preventDefault();const button=autoForm.querySelector('button[type="submit"]');button.disabled=true;
   try{
    await api.post('/api/library/folders/auto-scan',{enabled:autoForm.querySelector('[data-auto-enabled]').checked,intervalMinutes:Number(autoForm.querySelector('[data-auto-interval]').value),settleSeconds:Number(autoForm.querySelector('[data-auto-settle]').value)});
    autoForm.dataset.dirty='false';showToast('自动扫描设置已保存');await showLocalFoldersPage();
   }catch(error){autoForm.querySelector('[data-auto-error]').textContent=error.message;button.disabled=false}
  });
  page.querySelector('[data-add-folder]').addEventListener('click',browseFolders);
  page.querySelector('[data-scan-folders]').addEventListener('click',async()=>{try{await api.post('/api/library/folders/scan',{});await showLocalFoldersPage()}catch(error){showToast(error.message,'error')}});
  page.querySelectorAll('[data-rename]').forEach(button=>button.addEventListener('click',()=>editFolder(folders[Number(button.dataset.rename)])));
  page.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',()=>removeFolder(folders[Number(button.dataset.remove)])));
  const poll=()=>{
   if(!location.hash.startsWith('#/local-folders')&&!location.hash.startsWith('#/settings/local-folders'))return;
   if(autoForm.dataset.dirty==='true'||autoForm.contains(document.activeElement)){timer=setTimeout(poll,3000);return}
   showLocalFoldersPage();
  };
  timer=setTimeout(poll,status.running?1500:10000);
 }catch(error){page.innerHTML=`<p class="text-red-400">${html(error.message)}</p>`}
}
