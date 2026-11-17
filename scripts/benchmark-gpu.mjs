import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, playMove } from '../dist/engine.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name, fallback) => process.argv.find(item=>item.startsWith(`--${name}=`))?.slice(name.length+3) ?? fallback;
const backend = arg('backend','cuda');
const threads = Number(arg('threads','16')), batch = Number(arg('batch','16'));
const seconds = Number(arg('seconds','3')), rounds = Number(arg('rounds','3'));
const servers=Number(arg('servers','1'));
const label = arg('label',`${backend}-t${threads}-b${batch}`);
if(!['cuda','directml','tensorrt'].includes(backend)||![threads,batch].every(n=>Number.isInteger(n)&&n>=1&&n<=256)||!Number.isFinite(seconds)||seconds<0.1||seconds>60||!Number.isInteger(rounds)||rounds<1||rounds>20||![1,2,4].includes(servers)||!/^[a-zA-Z0-9_-]+$/.test(label))throw Error('Invalid benchmark options');
const directory=path.resolve(arg('directory',path.join(root,backend==='directml'?'engine':`engine-${backend}`)));
const executable=path.join(directory,'katago.exe');
const configFile=path.join(directory,`benchmark-${label}.cfg`);
const model=path.relative(directory,path.resolve(arg('model',path.join(root,'engine','model.bin.gz'))));
const humanModel=arg('human-model',null);
const memorySamples=[];let samplingMemory=false;
const memoryTimer=process.argv.includes('--sample-memory')?setInterval(()=>{
  if(samplingMemory)return;samplingMemory=true;
  execFile('nvidia-smi',['--query-gpu=memory.used,utilization.gpu','--format=csv,noheader,nounits'],{windowsHide:true,timeout:2500},(error,stdout)=>{
    samplingMemory=false;if(error)return;
    const values=stdout.trim().split(/\r?\n/)[0]?.split(',').map(value=>Number(value.trim()));
    if(values?.length===2&&values.every(Number.isFinite))memorySamples.push({memoryMiB:values[0],utilizationPercent:values[1]});
  });
},1000):null;
const columns='ABCDEFGHJKLMNOPQRST';
const gtp=index=>index===-1?'pass':columns[index%19]+(19-Math.floor(index/19));
const index=move=>(19-Number(move.slice(1)))*19+columns.indexOf(move[0]);

function positions() {
  let state=createGame(19,7.5),seed=0x4242026;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const opening=['D4','Q16','D16','Q4','C6','R14','F3','O17','O3','F17','C14','R6','D10','Q10'];
  const list=[{name:'opening',moves:[]}];
  for(const move of opening){const result=playMove(state,index(move));if(!result.ok)throw Error(result.error);state=result.state;}
  list.push({name:'middlegame',moves:state.moves.map(move=>[move.player===1?'B':'W',gtp(move.index)])});
  while(state.moves.length<90) {
    const candidates=[];
    for(let i=0;i<361;i++)if(!state.board[i]) {
      const row=Math.floor(i/19),col=i%19;
      let adjacent=0;
      for(const j of [row>0?i-19:-1,row<18?i+19:-1,col>0?i-1:-1,col<18?i+1:-1])if(j>=0&&state.board[j])adjacent++;
      candidates.push({index:i,priority:random()+adjacent*.65+(row>0&&row<18&&col>0&&col<18?.3:0)});
    }
    candidates.sort((a,b)=>b.priority-a.priority);
    let played=false;
    for(const candidate of candidates){const result=playMove(state,candidate.index);if(result.ok){state=result.state;played=true;break;}}
    if(!played)break;
  }
  list.push({name:'contact-fight',moves:state.moves.map(move=>[move.player===1?'B':'W',gtp(move.index)])});
  return list;
}

let config=(await readFile(path.join(directory,'analysis.cfg'),'utf8'))
  .replace(/^numSearchThreadsPerAnalysisThread\s*=.*$/m,`numSearchThreadsPerAnalysisThread = ${threads}`)
  .replace(/^nnMaxBatchSize\s*=.*$/m,`nnMaxBatchSize = ${batch}`);
config=config.replace(/^numNNServerThreadsPerModel\s*=.*$/m,'')+`\nnumNNServerThreadsPerModel = ${servers}\n`;
await writeFile(configFile,config);
const started=performance.now();
const child=spawn(executable,['analysis','-config',path.basename(configFile),'-model',model,...(humanModel?['-human-model',path.relative(directory,path.resolve(humanModel))]:[]),'-quit-without-waiting'],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
const pending=new Map();let logs='',serial=0,readyMs;
const lines=createInterface({input:child.stdout});
const fail=error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
child.on('error',fail);child.on('exit',code=>{if(pending.size)fail(Error(`Engine exited${code}: ${logs.slice(-4000)}`));});
child.stderr.on('data',chunk=>{logs=(logs+chunk).slice(-100000);if(readyMs==null&&/ready to begin handling requests/.test(chunk))readyMs=performance.now()-started;});
child.stdin.on('error',fail);
lines.on('line',line=>{let result;try{result=JSON.parse(line);}catch{return;}const item=pending.get(result.id);if(!item||result.isDuringSearch||result.warning)return;clearTimeout(item.timer);pending.delete(result.id);if(result.error)item.reject(Error(result.error));else item.resolve({result,wallMs:performance.now()-item.start});});
const query=(position,visits=1000000,time=seconds)=>new Promise((resolve,reject)=>{const id=`bench-${++serial}`;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`Benchmark timed out: ${logs.slice(-4000)}`));child.kill();},1_200_000);pending.set(id,{resolve,reject,timer,start:performance.now()});child.stdin.write(JSON.stringify({id,moves:position.moves,rules:'chinese-ogs',komi:7.5,boardXSize:19,boardYSize:19,maxVisits:visits,overrideSettings:{maxTime:time,wideRootNoise:0},includeOwnership:true})+'\n');});
const output={backend,threads,batch,servers,seconds,label,model:'kata1-tf3-b11c768-s12382M-d6533M',humanModel:humanModel??null,startedAt:new Date().toISOString(),samples:[]};
try {
  const states=positions();
  console.log(`Warming ${label}`);
  const warm=await query(states[0],16,3);
  output.startupMs=Math.round(readyMs??warm.wallMs);output.warmupMs=Math.round(warm.wallMs);
  for(let round=0;round<rounds;round++){
    const position=states[round%states.length];const {result,wallMs}=await query(position);
    const sample={position:position.name,plies:position.moves.length,visits:result.rootInfo?.visits,wallMs:Math.round(wallMs),visitsPerSecond:Number(((result.rootInfo?.visits??0)/(wallMs/1000)).toFixed(2)),move:result.moveInfos?.find(move=>move.order===0)?.move,winrate:result.rootInfo?.winrate,scoreLead:result.rootInfo?.scoreLead};
    output.samples.push(sample);console.log(JSON.stringify(sample));
  }
  output.averageVisitsPerSecond=Number((output.samples.reduce((sum,item)=>sum+item.visits,0)/(output.samples.reduce((sum,item)=>sum+item.wallMs,0)/1000)).toFixed(2));
  if(memorySamples.length)output.gpuMemory={globalPeakObservedMiB:Math.max(...memorySamples.map(sample=>sample.memoryMiB)),maxUtilizationPercent:Math.max(...memorySamples.map(sample=>sample.utilizationPercent)),samples:memorySamples,note:'Whole-GPU readings include other desktop/idle processes; observed peak is sampled, not a guaranteed allocation maximum.'};
  output.logs=logs;
  await mkdir(path.join(directory,'benchmarks'),{recursive:true});
  const destination=path.join(directory,'benchmarks',`${label}.json`);
  await writeFile(destination,JSON.stringify(output,null,2)+'\n');console.log(`RESULT ${JSON.stringify({backend,threads,batch,startupMs:output.startupMs,averageVisitsPerSecond:output.averageVisitsPerSecond,file:destination})}`);
} catch(error) {output.error=error.message;await mkdir(path.join(directory,'benchmarks'),{recursive:true});await writeFile(path.join(directory,'benchmarks',`${label}.json`),JSON.stringify(output,null,2)+'\n');throw error;}
finally {if(memoryTimer)clearInterval(memoryTimer);child.kill();lines.close();}
