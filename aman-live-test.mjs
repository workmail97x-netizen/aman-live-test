import fs from 'node:fs/promises'
import process from 'node:process'
import {pathToFileURL} from 'node:url'

const MODE=(process.argv[2]||process.env.AMAN_TEST_MODE||'smoke').toLowerCase()
const BASE_URL=String(process.env.AMAN_BASE_URL||'https://amaniq1.netlify.app').replace(/\/+$/,'')
const OWNER_EMAIL=String(process.env.AMAN_OWNER_EMAIL||'').trim()
const OWNER_PASSWORD=String(process.env.AMAN_OWNER_PASSWORD||'')
const RUN_ID=new Date().toISOString().replace(/\D/g,'').slice(2,14)
const startedAt=new Date().toISOString()
const results={run_id:RUN_ID,mode:MODE,base_url:BASE_URL,started_at:startedAt,checks:[],phases:[],created_test_tenants:[],warnings:[]}

function check(name,passed,details={}){
  results.checks.push({name,passed:Boolean(passed),details})
  console.log(`${passed?'PASS':'FAIL'} ${name}`)
  if(!passed)throw new Error(`${name}: ${JSON.stringify(details)}`)
}
function percentile(sorted,p){if(!sorted.length)return 0;return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]}
function aliasEmail(email,label){
  const [local,domain]=email.split('@')
  if(!local||!domain)throw new Error('AMAN_OWNER_EMAIL is not a valid email')
  return `${local.split('+')[0]}+${label.toLowerCase()}@${domain}`
}
async function request(url,options={}){
  const started=performance.now()
  try{
    const response=await fetch(url,{...options,signal:AbortSignal.timeout(Number(options.timeout||20000))})
    const text=await response.text()
    let body=null
    try{body=text?JSON.parse(text):null}catch{body={raw:text.slice(0,500)}}
    return {ok:response.ok,status:response.status,body,duration_ms:Number((performance.now()-started).toFixed(3))}
  }catch(error){return {ok:false,status:0,error:String(error?.message||error),duration_ms:Number((performance.now()-started).toFixed(3))}}
}
async function timedBurst(name,count,operation){
  const wallStart=performance.now()
  const rows=await Promise.all(Array.from({length:count},(_,index)=>operation(index)))
  const wallMs=performance.now()-wallStart
  const durations=rows.map(x=>x.duration_ms||0).sort((a,b)=>a-b)
  const statuses={}
  for(const row of rows)statuses[row.status||'network_error']=(statuses[row.status||'network_error']||0)+1
  const failed=rows.filter(x=>!x.ok).length
  const phase={name,concurrency:count,total:rows.length,failed,error_rate:Number((failed/rows.length*100).toFixed(3)),statuses,wall_ms:Number(wallMs.toFixed(3)),throughput_rps:Number((rows.length/(wallMs/1000)).toFixed(3)),avg_ms:Number((durations.reduce((a,b)=>a+b,0)/durations.length).toFixed(3)),p50_ms:percentile(durations,.50),p95_ms:percentile(durations,.95),p99_ms:percentile(durations,.99),max_ms:durations.at(-1)||0}
  results.phases.push(phase)
  console.log(`PHASE ${name}: ${JSON.stringify(phase)}`)
  return phase
}
async function writeReports(error=null){
  results.finished_at=new Date().toISOString()
  results.passed=!error&&results.checks.every(x=>x.passed)&&results.phases.every(x=>x.error_rate<=1)
  if(error)results.fatal_error=String(error?.stack||error)
  await fs.mkdir('artifacts',{recursive:true})
  await fs.writeFile('artifacts/aman-live-test-results.json',JSON.stringify(results,null,2))
  const lines=[
    '# AMAN RC4.2 live test',
    '',
    `- Run: ${results.run_id}`,
    `- Mode: ${results.mode}`,
    `- Started: ${results.started_at}`,
    `- Finished: ${results.finished_at}`,
    `- Result: ${results.passed?'PASS':'FAIL'}`,
    '',
    '## Checks','',
    ...results.checks.map(x=>`- ${x.passed?'PASS':'FAIL'} — ${x.name}`),
    '',
    '## Load phases','',
    '| Phase | Concurrency | Failed | Error % | P50 ms | P95 ms | P99 ms | RPS |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...results.phases.map(x=>`| ${x.name} | ${x.concurrency} | ${x.failed} | ${x.error_rate} | ${x.p50_ms} | ${x.p95_ms} | ${x.p99_ms} | ${x.throughput_rps} |`),
    '',
    '## Test tenants','',
    ...results.created_test_tenants.map(x=>`- ${x.login_code} — ${x.id}`),
    '',
    '> Test tenant cleanup is intentionally not automatic. Run the reviewed cleanup SQL only after explicit approval.'
  ]
  if(error)lines.push('','## Fatal error','',String(error?.message||error))
  await fs.writeFile('artifacts/aman-live-test-report.md',lines.join('\n'))
  if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join('\n'))
}

let ctx={}
async function bootstrap(){
  if(!OWNER_EMAIL||!OWNER_PASSWORD)throw new Error('AMAN_OWNER_EMAIL and AMAN_OWNER_PASSWORD secrets are required')
  const index=await request(`${BASE_URL}/?qa=${RUN_ID}`)
  check('Netlify reachable',index.ok,{status:index.status})
  check('RC4.2 frontend published',/1\.0\.0-rc4\.2/i.test(String(index.body?.raw||''))||/1\.0\.0-rc4\.2/i.test(await (await fetch(`${BASE_URL}/`)).text()),{status:index.status})
  const configResponse=await fetch(`${BASE_URL}/config.js?qa=${RUN_ID}`,{signal:AbortSignal.timeout(20000)})
  const configText=await configResponse.text()
  const supabaseUrl=configText.match(/supabaseUrl:\s*['\"]([^'\"]+)/)?.[1]
  const publishableKey=configText.match(/supabaseAnonKey:\s*['\"]([^'\"]+)/)?.[1]
  check('Public cloud config found',Boolean(supabaseUrl&&publishableKey),{config_status:configResponse.status})
  const auth=await request(`${supabaseUrl}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:publishableKey,'Content-Type':'application/json'},body:JSON.stringify({email:OWNER_EMAIL,password:OWNER_PASSWORD})})
  check('Platform owner authentication',auth.ok&&Boolean(auth.body?.access_token),{status:auth.status,error:auth.body?.error||auth.body?.msg})
  ctx={supabaseUrl,publishableKey,accessToken:auth.body.access_token}
}
function functionRequest(name,body,authenticated=false){
  return request(`${ctx.supabaseUrl}/functions/v1/${name}`,{method:'POST',headers:{apikey:ctx.publishableKey,'Content-Type':'application/json',...(authenticated?{Authorization:`Bearer ${ctx.accessToken}`}:{})},body:JSON.stringify(body),timeout:30000})
}
async function platform(body){return functionRequest('aman-platform-api',body,true)}
async function branding(code){return functionRequest('aman-auth-api',{action:'organization_branding',tenant_code:code},false)}
async function latestTestTenants(){
  const snap=await platform({action:'snapshot'})
  check('Platform snapshot available',snap.ok&&Array.isArray(snap.body?.organizations),{status:snap.status,error:snap.body?.error})
  return (snap.body.organizations||[]).filter(x=>/^TST[AB]/.test(String(x.login_code||''))).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))
}
async function createSmokeTenants(){
  const codeA=`TSTA${RUN_ID}`.slice(0,24),codeB=`TSTB${RUN_ID}`.slice(0,24)
  const common={industry:'residential',structure_type:'mixed',plan:'business',subscription_status:'trial',max_sites:2,max_members:1200,redirect_to:BASE_URL,contact_name:'AMAN QA AUTOMATION'}
  const a=await platform({action:'create_tenant',...common,name_ar:'مجمع اختبار أمان أ',name_en:'AMAN Test Complex A',login_code:codeA,admin_name_ar:'مدير اختبار أ',admin_name_en:'Test Admin A',admin_email:aliasEmail(OWNER_EMAIL,`aman-${codeA}`),brand_color:'#2457C5',brand_secondary_color:'#18A999'})
  check('Create test tenant A',a.ok&&a.body?.organization?.id,{status:a.status,error:a.body?.error,message:a.body?.message})
  results.created_test_tenants.push({id:a.body.organization.id,login_code:codeA})
  const b=await platform({action:'create_tenant',...common,name_ar:'مجمع اختبار أمان ب',name_en:'AMAN Test Complex B',login_code:codeB,admin_name_ar:'مدير اختبار ب',admin_name_en:'Test Admin B',admin_email:aliasEmail(OWNER_EMAIL,`aman-${codeB}`),brand_color:'#7A3E9D',brand_secondary_color:'#D97706'})
  check('Create test tenant B',b.ok&&b.body?.organization?.id,{status:b.status,error:b.body?.error,message:b.body?.message})
  results.created_test_tenants.push({id:b.body.organization.id,login_code:codeB})
  return {a:a.body.organization,b:b.body.organization,codeA,codeB}
}
async function smoke(){
  const initial=await latestTestTenants()
  results.warnings.push(`Existing AMAN QA tenants before run: ${initial.length}`)
  const tenants=await createSmokeTenants()
  const [brandA,brandB]=await Promise.all([branding(tenants.codeA),branding(tenants.codeB)])
  check('Public branding A',brandA.ok&&brandA.body?.organization?.brand_color==='#2457C5',{status:brandA.status,body:brandA.body})
  check('Public branding B',brandB.ok&&brandB.body?.organization?.brand_color==='#7A3E9D',{status:brandB.status,body:brandB.body})
  const safeKeys=new Set(['login_code','name_ar','name_en','brand_color','brand_secondary_color','brand_logo_data_url'])
  check('Public branding exposes safe fields only',Object.keys(brandA.body.organization||{}).every(k=>safeKeys.has(k)),{keys:Object.keys(brandA.body.organization||{})})
  const logo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
  const updated=await platform({action:'update_tenant',id:tenants.a.id,brand_color:'#174EA6',brand_secondary_color:'#0F9D8A',brand_logo_data_url:logo})
  check('Owner updates tenant branding',updated.ok&&updated.body?.organization?.brand_color==='#174EA6',{status:updated.status,error:updated.body?.error})
  const refreshed=await branding(tenants.codeA)
  check('Updated branding visible publicly',refreshed.ok&&refreshed.body?.organization?.brand_logo_data_url===logo&&refreshed.body?.organization?.brand_color==='#174EA6',{status:refreshed.status})
  const invalidColor=await platform({action:'update_tenant',id:tenants.a.id,brand_color:'#FFFFFF'})
  check('Unsafe low-contrast primary rejected',invalidColor.status===400&&invalidColor.body?.error==='INVALID_PRIMARY_BRAND_COLOR',{status:invalidColor.status,error:invalidColor.body?.error})
  const invalidLogo=await platform({action:'update_tenant',id:tenants.a.id,brand_logo_data_url:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='})
  check('SVG logo rejected',invalidLogo.status===400&&invalidLogo.body?.error==='INVALID_BRAND_LOGO',{status:invalidLogo.status,error:invalidLogo.body?.error})
  const missing=await branding(`MISSING${RUN_ID}`.slice(0,24))
  check('Unknown organization rejected',missing.status===404,{status:missing.status,error:missing.body?.error})
  const publicPhase=await timedBurst('smoke-public-branding',25,()=>branding(tenants.codeA))
  check('Smoke public requests healthy',publicPhase.failed===0,publicPhase)
  const ownerPhase=await timedBurst('smoke-owner-snapshot',25,()=>platform({action:'snapshot'}))
  check('Smoke authenticated requests healthy',ownerPhase.failed===0,ownerPhase)
}
async function load(){
  const tenants=await latestTestTenants()
  const tenant=tenants[0]
  check('Existing test tenant available for load',Boolean(tenant?.login_code),{test_tenants:tenants.length})
  const requested=String(process.env.AMAN_LOAD_STEPS||'25,50,100,200,500,1000').split(',').map(Number).filter(x=>Number.isInteger(x)&&x>0&&x<=1000)
  for(const size of requested){
    const publicPhase=await timedBurst(`public-branding-${size}`,size,()=>branding(tenant.login_code))
    const ownerPhase=await timedBurst(`owner-snapshot-${size}`,size,()=>platform({action:'snapshot'}))
    const combinedFailed=publicPhase.failed+ownerPhase.failed,combinedTotal=publicPhase.total+ownerPhase.total
    if(combinedFailed/combinedTotal>0.01){
      results.warnings.push(`Stopped after concurrency ${size}: combined error rate exceeded 1%`)
      break
    }
    await new Promise(resolve=>setTimeout(resolve,1500))
  }
}

export async function main(){
  try{
    if(!['smoke','load'].includes(MODE))throw new Error(`Unsupported mode: ${MODE}`)
    await bootstrap()
    if(MODE==='smoke')await smoke();else await load()
    await writeReports()
    if(!results.passed)process.exitCode=1
  }catch(error){
    console.error(error)
    await writeReports(error)
    process.exitCode=1
  }
}

export {results}

if(import.meta.url===pathToFileURL(process.argv[1]).href)await main()
