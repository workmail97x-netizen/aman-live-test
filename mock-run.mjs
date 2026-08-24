import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

process.env.AMAN_BASE_URL='https://mock.aman.invalid'
process.env.AMAN_OWNER_EMAIL='owner+mock@example.com'
process.env.AMAN_OWNER_PASSWORD='mock-password'
process.env.AMAN_TEST_MODE='smoke'

const tenants=[]
let nextId=1
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})

globalThis.fetch=async(url,options={})=>{
  const parsed=new URL(String(url)),text=String(options.body||''),body=text?JSON.parse(text):{}
  if(parsed.pathname==='/config.js')return new Response("window.AMAN_CONFIG={supabaseUrl:'https://mock.aman.invalid',supabaseAnonKey:'public-test-key'};",{status:200,headers:{'content-type':'text/javascript'}})
  if(parsed.pathname==='/auth/v1/token')return json({access_token:'mock-owner-token'})
  if(parsed.pathname==='/functions/v1/aman-platform-api'){
    if(body.action==='snapshot')return json({ok:true,organizations:tenants,usage:{}})
    if(body.action==='create_tenant'){
      const org={id:`org-${nextId++}`,login_code:body.login_code,name_ar:body.name_ar,name_en:body.name_en,brand_color:body.brand_color,brand_secondary_color:body.brand_secondary_color,brand_logo_data_url:null,contact_name:body.contact_name,created_at:new Date().toISOString()};tenants.push(org)
      return json({ok:true,organization:org,site:{id:'site'},gate:{id:'gate'},admin_profile:{id:'admin'}})
    }
    if(body.action==='update_tenant'){
      if(body.brand_color==='#FFFFFF')return json({error:'INVALID_PRIMARY_BRAND_COLOR'},400)
      if(String(body.brand_logo_data_url||'').startsWith('data:image/svg'))return json({error:'INVALID_BRAND_LOGO'},400)
      const org=tenants.find(x=>x.id===body.id);Object.assign(org,body);return json({ok:true,organization:org})
    }
    return json({error:'UNKNOWN_ACTION'},400)
  }
  if(parsed.pathname==='/functions/v1/aman-auth-api'){
    const org=tenants.find(x=>x.login_code===body.tenant_code)
    if(!org)return json({error:'ORGANIZATION_NOT_FOUND'},404)
    const {login_code,name_ar,name_en,brand_color,brand_secondary_color,brand_logo_data_url}=org
    return json({ok:true,organization:{login_code,name_ar,name_en,brand_color,brand_secondary_color,brand_logo_data_url}})
  }
  return new Response('<!doctype html><script src="app.js?v=1.0.0-rc4.2"></script>',{status:200,headers:{'content-type':'text/html'}})
}

const {main,results}=await import('../scripts/aman-live-test.mjs')
await main()
assert.equal(process.exitCode||0,0)
assert.equal(results.passed,true)
assert.equal(results.created_test_tenants.length,2)
assert.equal(results.phases.length,2)
assert.equal(results.phases.every(x=>x.failed===0),true)
const report=JSON.parse(await fs.readFile('artifacts/aman-live-test-results.json','utf8'))
assert.equal(report.passed,true)
console.log('Mock smoke test passed')
