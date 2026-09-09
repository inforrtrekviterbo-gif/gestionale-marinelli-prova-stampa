import {root,fixture,data,auth,fiscal,pdf,products} from './harness.mjs';
import {fileURLToPath} from 'node:url';
const qaRoot=fileURLToPath(new URL('.',import.meta.url));
const {createServer}=await import(root+'/node_modules/vite/dist/node/index.js');
const {default:react}=await import(root+'/node_modules/@vitejs/plugin-react/dist/index.js');
const f=await fixture();
const api={name:'isolated-api',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(!req.url.startsWith('/api/'))return next();
  try{
    const chunks=[];for await(const c of req)chunks.push(c);
    const url='http://localhost:4173'+req.url;
    const body=Buffer.concat(chunks);
    const request=new Request(url,{method:req.method,headers:req.headers,...(body.length?{body,duplex:'half'}:{})});
    const route=req.url.split('?')[0];const module=route==='/api/auth'?auth:route==='/api/data'?data:route==='/api/products'?products:route==='/api/pdf'?pdf:fiscal;
    const response=await f.run(()=>module[req.method](request));
    const responseHeaders=Object.fromEntries(response.headers);
    if(responseHeaders['set-cookie']) responseHeaders['set-cookie']=responseHeaders['set-cookie'].replace('; Secure','');
    res.writeHead(response.status,responseHeaders);res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});}};
const server=await createServer({root:qaRoot,configFile:false,publicDir:root+'/public',plugins:[api,react()],resolve:{alias:[{find:/^firebase\/(app|auth|database)$/,replacement:qaRoot+'firebase-mock.js'},{find:/^react-dom(\/.*)?$/,replacement:root+'/node_modules/react-dom$1'},{find:/^react(\/.*)?$/,replacement:root+'/node_modules/react$1'}]},css:{postcss:root},server:{host:'0.0.0.0',port:4173,strictPort:true,fs:{allow:[root,qaRoot]}}});
await server.listen();server.printUrls();
