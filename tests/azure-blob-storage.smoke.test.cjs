const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Readable } = require('node:stream');
const adapterPath = path.join(__dirname, '..', 'src', 'api', 'integrations', 'storage', 's3', 'libs', 'minio.server.ts');
const source = fs.readFileSync(adapterPath, 'utf8');
const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, reportDiagnostics: true });
const errors = (out.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
assert.equal(errors.length, 0, errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));

function harness(provider='azure') {
  const calls = { azure: [], minio: [] };
  const env = { S3_ENABLED: provider === 's3' ? 'true' : 'false', S3_BUCKET: 'evolution-media',
    S3_ENDPOINT: 'minio.local', S3_PORT: '9000', S3_USE_SSL: 'false', S3_REGION: 'test',
    S3_ACCESS_KEY: 'key', S3_SECRET_KEY: 'secret', S3_SKIP_POLICY: 'true',
    AZURE_BLOB_ACCOUNT_NAME: 'testaccount', AZURE_BLOB_CONTAINER: 'evolution-media', AZURE_BLOB_SAVE_VIDEO: 'true' };
  class DefaultAzureCredential {}
  class BlobServiceClient {
    constructor(endpoint) { this.endpoint = endpoint; }
    getContainerClient(container) { return {
      createIfNotExists: async () => ({}),
      getBlockBlobClient: name => ({ url: `${this.endpoint}/${container}/${name}`,
        uploadData: async (buffer, options) => { calls.azure.push({ op:'data', name, options, buffer }); return {}; },
        uploadStream: async (stream, chunkSize, concurrency, options) => { const chunks=[]; for await (const c of stream) chunks.push(Buffer.from(c)); calls.azure.push({op:'stream',name,options,data:Buffer.concat(chunks)}); return {}; },
      }),
      getBlobClient: name => ({ url: `${this.endpoint}/${container}/${name}`, deleteIfExists: async () => { calls.azure.push({op:'delete',name}); return {}; } }),
    }; }
    async getUserDelegationKey(startsOn, expiresOn) { calls.azure.push({op:'key',startsOn,expiresOn}); return {}; }
  }
  class BlobSASPermissions { static parse(v) { return v; } }
  const SASProtocol = { Https:'https' };
  const generateBlobSASQueryParameters = (values,key,accountName) => { calls.azure.push({op:'sas',values,accountName}); return {toString:()=> 'sig=test&sp=r'}; };
  class MinioClient {
    async listBuckets() { return [{name:'evolution-media'}]; }
    async putObject(bucket,name,file,size,metadata) { calls.minio.push({op:'put',name}); return {}; }
    async presignedGetObject(bucket,name,expiry) { calls.minio.push({op:'url',name}); return 'https://minio.local/object'; }
    async removeObject(bucket,name) { calls.minio.push({op:'delete',name}); return {}; }
    async makeBucket() {}
    async setBucketPolicy() {}
  }
  const mocks = {
    '@azure/identity': {DefaultAzureCredential},
    '@azure/storage-blob': {BlobServiceClient,BlobSASPermissions,generateBlobSASQueryParameters,SASProtocol},
    '@config/env.config': {ConfigService: class { get(k) {
      if (k==='S3') return {ENABLE:provider!=='none',BUCKET_NAME:env.S3_BUCKET,ENDPOINT:env.S3_ENDPOINT,PORT:9000,USE_SSL:false,ACCESS_KEY:'key',SECRET_KEY:'secret',REGION:'test',SKIP_POLICY:true,SAVE_VIDEO:true};
      if (k==='AZURE_BLOB') return {ENABLED:provider==='azure',ACCOUNT_NAME:env.AZURE_BLOB_ACCOUNT_NAME,CONTAINER_NAME:env.AZURE_BLOB_CONTAINER,ENDPOINT:''};
    }}},
    '@config/logger.config': {Logger: class {info(){} error(){}}},
    '@exceptions': {BadRequestException: class extends Error {}},
    minio: {Client:MinioClient}, path: require('node:path'), stream: require('node:stream'),
  };
  const m={exports:{}};
  vm.runInNewContext(out.outputText,{exports:m.exports,module:m,Buffer,process:{env},console,require:id=>{if(Object.hasOwn(mocks,id))return mocks[id];throw Error('unexpected '+id);}});
  return {api:m.exports,calls};
}
(async()=>{
  const h=harness();
  await h.api.uploadFile('photo.jpg',Buffer.from('x'),1,{'Content-Type':'image/jpeg'});
  const u=h.calls.azure.find(x=>x.op==='data');
  assert.equal(u.name,'evolution-api/photo.jpg');
  assert.equal(u.options.blobHTTPHeaders.blobContentType,'image/jpeg');
  assert.equal(u.options.metadata.custom_header_application,'evolution-api');
  assert.equal(await h.api.getObjectUrl('photo.jpg',120),'https://testaccount.blob.core.windows.net/evolution-media/evolution-api/photo.jpg?sig=test&sp=r');
  assert.equal(h.calls.azure.find(x=>x.op==='sas').values.permissions,'r');
  const s=harness();
  await s.api.uploadFile('clip.mp4',Readable.from([Buffer.from('a'),Buffer.from('b')]),2,{'Content-Type':'video/mp4'});
  assert.equal(s.calls.azure.find(x=>x.op==='stream').data.toString(),'ab');
  await s.api.uploadTempFile('temp','x.bin',Buffer.from('x'),1,{'Content-Type':'application/octet-stream'});
  await s.api.deleteFile('temp','x.bin');
  assert.ok(s.calls.azure.some(x=>x.op==='delete'));
  await assert.rejects(()=>harness().api.uploadFile('../oops',Buffer.from('x'),1,{'Content-Type':'x'}),/Invalid media object name/);
  const m=harness('s3');
  await m.api.uploadFile('photo.jpg',Buffer.from('x'),1,{'Content-Type':'image/jpeg'});
  assert.ok(m.calls.minio.some(x=>x.op==='put'));
  assert.match(await m.api.getObjectUrl('photo.jpg',30),/minio\.local/);
  console.log('PASS Azure buffer, stream, SAS, temp/delete, traversal and MinIO routing smoke tests (all storage clients mocked)');
})().catch(e=>{console.error(e);process.exitCode=1;});
