import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
export const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
registerHooks({resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return {url:'data:text/javascript,export const env = {}',shortCircuit:true};
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (existsSync(new URL(url.href+'.ts'))) return next(url.href+'.ts',context);
  }
  return next(specifier, context);
}});
const load = (p) => import(pathToFileURL(root+'/'+p));
export const data = await load('app/api/data/route.ts');
export const auth = await load('app/api/auth/route.ts');
export const fiscal = await load('app/api/fiscal/route.ts');
export const pdf = await load('app/api/pdf/route.ts');
export const products = await load('app/api/products/route.ts');
export const runtime = await load('lib/runtime-db.ts');
export const {runWithRequestEnv} = await load('lib/request-env.ts');
export const {createPdf} = await load('lib/pdf.ts');
export const state = {offline:false, writes:0};
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (u.hostname === 'identitytoolkit.googleapis.com') {
    const {idToken} = JSON.parse(init.body);
    if (!['admin','viterbo','gran-sasso'].includes(idToken)) return Response.json({}, {status:401});
    return Response.json({users:[{localId:'test-'+idToken,email:idToken+'@gestionale.local'}]});
  }
  if (u.hostname.endsWith('.firebasedatabase.app')) {
    state.writes++;
    return Response.json({}, {status:state.offline?503:200});
  }
  throw new Error('External request blocked by isolated test harness: '+u.hostname);
};
export async function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  const control = { fail:null, statements:0 };
  const db = {prepare(query) {
    let values=[];
    const execute = (mode) => {
      control.statements++;
      if (control.fail && control.fail(query,values)) throw new Error('Injected database failure');
      const stmt=sql.prepare(query);
      if(mode==='run') { const r=stmt.run(...values); return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}; }
      if(mode==='all') return {results:stmt.all(...values)};
      return stmt.get(...values)??null;
    };
    return {_run(){return execute('run');},bind(...v){values=v;return this;},async first(column){const row=execute('first');if(control.afterRead)await control.afterRead(query,row);return column?row?.[column]??null:row;},async all(){return execute('all');},async run(){return execute('run');}};
  },async batch(statements){sql.exec('BEGIN');try{const r=[];for(const stmt of statements)r.push(stmt._run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const run = (fn)=>runWithRequestEnv({DB:db},fn);
  await run(()=>runtime.ensureDatabase());
  const cookies={};
  for(const name of ['admin','viterbo','gran-sasso']) {
    const response=await run(()=>auth.POST(new Request('http://qa/api/auth',{method:'POST',body:JSON.stringify({action:'firebase-login',idToken:name})})));
    cookies[name]=response.headers.get('set-cookie').split(';')[0];
  }
  async function request(route, method='GET', name='admin', body, extra={}) {
    const headers={...(name?{cookie:cookies[name],authorization:'Bearer '+name}:{}),...extra};
    const req=new Request('http://qa'+route,{method,headers, ...(body!==undefined?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
    const module=route.startsWith('/api/auth')?auth:route.startsWith('/api/fiscal')?fiscal:route.startsWith('/api/pdf')?pdf:route.startsWith('/api/products')?products:data;
    return run(()=>module[method](req));
  }
  async function call(action,body={},name='admin') {const r=await request('/api/data','POST',name,{action,...body});return {status:r.status,...await r.json()};}
  const row=(query,...args)=>sql.prepare(query).get(...args);
  return {sql,db,control,run,cookies,request,call,row};
}
export function item(overrides={}) {return {productId:1,description:'Prodotto prova',quantity:1,unitPrice:10,discountPercent:0,itemType:'product',metadata:{},...overrides};}
export function sale(overrides={}) {return {store:'Viterbo',items:[item()],total:10,cashAmount:10,...overrides};}
