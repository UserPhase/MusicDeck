const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { build } = require('../../server/node_modules/esbuild');
const WebSocket = require('../../server/node_modules/ws');
const root = path.resolve(__dirname, '../..');
const web = path.join(root, 'webapp');
const workspaceTemp = path.join(root, '.tmp');
fs.mkdirSync(workspaceTemp, {recursive:true});
const work = fs.mkdtempSync(path.join(workspaceTemp, 'track-touch-check-'));
const out = path.join(work, 'out');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mockPlayer = `const player={ currentSong:null,isPlaying:false,likedSongIds:new Set(),downloadQuality:'320kbps',togglePlay(){},queueTracks(t){window.actions.push(['queue',t.map(x=>x.id)])},playTracksNext(t){window.actions.push(['next',t.map(x=>x.id)])},setTrackFavorite:async()=>{},playQueue:async()=>{} }; export const usePlayer=()=>player;`;
const replacements = new Map([
  [path.join(web, 'src/context/PlayerContext'), mockPlayer],
  [path.join(web, 'src/context/AuthContext'), `export const useAuth=()=>({session:{id:'fixture-user',role:'user'}});`],
  [path.join(web, 'src/context/PrivacyContext'), `export const usePrivacy=()=>({canImport:true,canMetadata:true,canArtwork:true,policy:{effective:{external:true}}});`],
  [path.join(web, 'src/services/storage/OfflineAuditor'), `export const useOfflineAudit=()=>({status:'missing'}); export const offlineDisplayStatus=()=> 'not-downloaded'; export const offlineAuditor={recordDownloaded:async()=>({status:'verified'})};`],
]);
const source = `import React,{useRef} from 'react'; import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,Link} from 'react-router-dom';
import VirtualizedTrackList from './src/components/VirtualizedTrackList';
import {useRouteScrollRestoration} from './src/hooks/useViewStateStore';
import './src/styles/tokens.css';import './src/styles/layout.css';import './src/styles/tracks.css';import './src/styles/glassmorphic.css';import './src/styles/theme.css';
window.actions=[];
window.fetch=async(url)=>{if(!String(url).startsWith('/api/'))throw new Error('Unexpected external request');return new Response(JSON.stringify({discoveries:[],settings:[],playlists:[],tracks:[],results:{track:[]}}),{headers:{'content-type':'application/json'}})};
const tracks=Array.from({length:200},(_,i)=>({id:'track-'+i,title:'Night Signals '+i,artist:'The Midnight',album:'After Hours',artistId:'artist-1',albumId:'album-1',duration:184,source:{kind:'library'}}));
function Shell(){const ref=useRef(null);useRouteScrollRestoration(ref);return <main ref={ref} id='scroller' style={{height:'100dvh',overflowY:'auto',padding:'12px',boxSizing:'border-box'}}><Routes>
<Route path='/tracks' element={<><h1 style={{fontSize:24}}>Your tracks</h1><p>Select music for what comes next.</p><div className='track-list' role='grid'><VirtualizedTrackList itemCount={tracks.length} getItem={i=>tracks[i]} getItemKey={i=>'entry-'+i} onReorder={()=>{}} dataKey='fixture' onPlay={song=>window.actions.push(['play',song.id])}/></div></>}/>
<Route path='/artist/artist-1' element={<><h1>Artist detail</h1><Link to='/tracks'>Back to tracks</Link></>}/>
<Route path='/album/album-1' element={<><h1>Album detail</h1><Link to='/tracks'>Back to tracks</Link></>}/>
</Routes></main>}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/tracks']}><Shell/></MemoryRouter>);`;

(async () => {
  await build({ stdin:{contents:source,resolveDir:web,sourcefile:'touch-fixture.tsx',loader:'tsx'},bundle:true,outfile:path.join(out,'harness.js'),jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{
    name:'isolated-fixture',setup(builder){ builder.onResolve({filter:/context\/(PlayerContext|AuthContext|PrivacyContext)|storage\/OfflineAuditor/},args=>{
      const absolute=path.resolve(args.resolveDir,args.path).replace(/\.(tsx?|jsx?)$/,'');
      return replacements.has(absolute)?{path:absolute,namespace:'fixture'}:null;
    });builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:replacements.get(args.path),loader:'js'}));}
  }]});
  const binary=process.env.CHROME_PATH||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/google-chrome','/usr/bin/chromium-browser'].find(file=>fs.existsSync(file));
  assert(binary,'Set CHROME_PATH to a Chromium browser executable for this isolated test');
  const server=http.createServer((req,res)=>{
    const name=req.url==='/harness.js'?'harness.js':req.url==='/harness.css'?'harness.css':null;
    if(name){res.setHeader('content-type',name.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(out,name)));}
    else {res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body style="margin:0;background:#141414;color:#eee"><div id="root"></div><script src="/harness.js"></script></body></html>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

  const profile=fs.mkdtempSync(path.join(work,'edge-profile-'));
  const browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let socket, rpc;
  try {
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let i=0;i<100&&!fs.existsSync(portFile);i++)await delay(100);
    assert(fs.existsSync(portFile),'Headless browser did not start');
    const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
    let id=0;const pending=new Map();const errors=[];
    socket.on('message',bytes=>{const msg=JSON.parse(String(bytes));if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.text);if(msg.id){const call=pending.get(msg.id);if(call){pending.delete(msg.id);clearTimeout(call.timer);msg.error?call.reject(new Error(JSON.stringify(msg.error))):call.resolve(msg.result)}}});
    rpc=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP timeout: ${method}`))},15000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));});
    const evaluate=async(expression)=>{const result=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value};
    const wait=async(expression)=>{for(let i=0;i<60;i++){if(await evaluate(`Boolean(${expression})`))return;await delay(50)}throw new Error('UI condition did not settle: '+expression)};
    const box=async(selector)=>evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    const tap=async(selector,hold=50)=>{const p=await box(selector);await rpc('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await delay(hold);await rpc('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(100)};
    await rpc('Runtime.enable');await rpc('Page.enable');
    await rpc('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await rpc('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await rpc('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
    await wait(`document.querySelector('[aria-label="Night Signals 0 by The Midnight"]')`);
    const first='[aria-label="Night Signals 0 by The Midnight"] .track-title-text';
    await tap(first);assert.equal(await evaluate('window.actions.length'),1,'Normal tap should play once');
    await tap(first,550);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Select Night Signals 0"]').checked`),true,'Hold must select once');
    assert.equal(await evaluate('window.actions.length'),1,'Long press must not play');
    await tap('[aria-label="Night Signals 1 by The Midnight"] .track-title-text');
    assert.equal(await evaluate('document.querySelectorAll(".track-selection-checkbox:checked").length'),2,'Second tap should extend selection');
    await tap('.universal-track-toolbar button:last-of-type');
    await wait('document.querySelector(".universal-track-context-menu")');
    const bounds=await evaluate('(()=>{const r=document.querySelector(".universal-track-context-menu").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth}})()');
    assert(bounds.left>=0&&bounds.right<=390&&bounds.top>=0&&bounds.bottom<=844,'Menu must fit the mobile viewport');
    const screenshot=process.env.MUSICDECK_TOUCH_SCREENSHOT_PATH;
    if(screenshot){fs.mkdirSync(path.dirname(path.resolve(screenshot)),{recursive:true});const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(screenshot,Buffer.from(shot.data,'base64'));}
    await tap('.universal-track-context-menu > button:nth-of-type(2)');
    assert.deepEqual(await evaluate(`window.actions.find(action=>action[0]==='next')`),['next',['track-0','track-1']],'Batch action must preserve track order through the portal');
    await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
    await evaluate(`document.querySelector('.track-selection-controls button').click()`);
    await tap(first,2250);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Select Night Signals 0"]').checked`),true,'Releasing an extended hold must not undo selection');
    await evaluate(`document.querySelector('.track-selection-controls button').click()`);
    await evaluate(`document.getElementById('scroller').scrollTop=640`);await delay(150);
    const visible=await evaluate(`(()=>{const rows=[...document.querySelectorAll('.track')];const row=rows.find(e=>{const r=e.getBoundingClientRect();return r.top>100&&r.bottom<600});return {id:row.getAttribute('aria-label'),y:document.getElementById('scroller').scrollTop}})()`);
    const selector=`[aria-label=${JSON.stringify(visible.id)}] .track-title-text`;
    const p=await box(selector);
    await rpc('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:2}]});await delay(80);
    for(let step=1;step<=6;step++){await rpc('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x,y:p.y-step*18,id:2}]});await delay(25)}
    await rpc('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(600);
    assert.equal(await evaluate('document.querySelectorAll(".track-selection-checkbox").length'),0,'Pan must not enter selection mode');
    assert.equal(await evaluate(`window.actions.filter(action=>action[0]==='play').length`),1,'Pan must not play');
    await evaluate(`document.getElementById('scroller').scrollTop=1024.5`);await delay(180);
    const restoreAt=await evaluate('document.getElementById("scroller").scrollTop');
    const link=await evaluate(`(()=>{const e=[...document.querySelectorAll('.track-artist')].find(e=>{const r=e.getBoundingClientRect();return r.top>80&&r.bottom<600});e.click();return true})()`);
    assert(link);await wait(`document.body.textContent.includes('Artist detail')`);
    assert.equal(await evaluate(`window.actions.filter(action=>action[0]==='play').length`),1,'Inline artist link must not play');
    await evaluate(`document.querySelector('a').click()`);await wait('document.querySelector(".virtual-track-window")');await delay(150);
    const restored=await evaluate('document.getElementById("scroller").scrollTop');
    assert(Math.abs(restored-restoreAt)<1,`Scroll restore mismatch: ${restoreAt} -> ${restored}`);
    assert.deepEqual(errors,[],'No browser runtime exceptions');
    console.log(JSON.stringify({viewport:390,normalTap:'passed',longPress500ms:'passed',extendedHold:'passed',batchSelection:'passed',playNextBatch:'passed',menuFitsViewport:bounds,scrollGesture:'passed',inlineLink:'passed',scrollRestoration:{before:restoreAt,after:restored},screenshot},null,2));
  } finally {
    if(socket?.readyState===WebSocket.OPEN&&rpc){try{await rpc('Browser.close')}catch{ /* The browser can close its socket before acknowledging shutdown. */ }}
    socket?.close();
    if(browser.exitCode===null){await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),delay(2000)]);if(browser.exitCode===null)browser.kill();}
    await new Promise(resolve=>server.close(resolve));

  }
})().finally(() => {
  const resolved=path.resolve(work);
  assert(resolved.startsWith(path.resolve(workspaceTemp)+path.sep)&&path.basename(resolved).startsWith('track-touch-check-'),'Unexpected temporary directory');
  if(process.platform==='win32'){
    // Native PowerShell handles Chromium's Windows profile attributes; verify the same boundary there before deleting.
    const cleaned=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      "$target=[IO.Path]::GetFullPath($env:MD_TOUCH_TEMP); $base=[IO.Path]::GetFullPath($env:MD_TOUCH_TEMP_BASE); if (-not $target.StartsWith($base+[IO.Path]::DirectorySeparatorChar) -or -not ([IO.Path]::GetFileName($target).StartsWith('track-touch-check-'))) { throw 'Unexpected temporary directory' }; if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop }"],
      {windowsHide:true,encoding:'utf8',env:{...process.env,MD_TOUCH_TEMP:resolved,MD_TOUCH_TEMP_BASE:workspaceTemp}});
    if(cleaned.status!==0)throw new Error('Could not remove temporary browser files: '+cleaned.stderr);
  }else fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}).catch(error=>{console.error(error);process.exitCode=1});
