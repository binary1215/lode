import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { resolveVerifiedProcessSupervisor, spawnSupervisedProcess } from "./runtime-process-supervisor.mjs";
import { GitSnapshotStore } from "./git-snapshot-store.mjs";
import { safeSnapshotPath, SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
import { hydrateSnapshotEntry } from "./snapshot-domain-bundles.mjs";
import { withSnapshotCollectionUnlink, snapshotCollectionCancelled } from "./snapshot-reference-lifetime.mjs";

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const OID = /^[a-f0-9]{64}$/;
const REF = /^refs\/lode-snapshots\/((?:world-model|graph-snapshot)-[a-f0-9]{24})$/;
const identity = s => ({ dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs), birthtime: String(s.birthtimeNs) });
const same = (a,b) => Object.keys(a).every(k => a[k] === b[k]);
const fileHash = file => { const fd=fs.openSync(file,"r"), h=crypto.createHash("sha256"), buffer=Buffer.alloc(64*1024); try { let n; while((n=fs.readSync(fd,buffer,0,buffer.length,null))) h.update(buffer.subarray(0,n)); } finally {fs.closeSync(fd);} return h.digest("hex"); };
const stable = value => JSON.stringify(value, Object.keys(value).sort());
const MAX_STORED = 1024 ** 3;

// Pure, bounded address validation for the existing synchronous pointer API.
// This checks storage existence, not Product meaning. Caller owns the lifetime.
export function verifyLooseSnapshotAddress({ root, storage, id }) {
  const store = new GitSnapshotStore({ projectRoot: root, storage });
  if (!store.checkOwner()) return false;
  const file = safeSnapshotPath(root, path.join(store.directory, store.ref(id)));
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    const packed=safeSnapshotPath(root,path.join(store.directory,"packed-refs"));if(!fs.existsSync(packed))return false;
    const ps=fs.lstatSync(packed);if(!ps.isFile()||ps.isSymbolicLink()||ps.nlink!==1||ps.size>16*1024*1024)fail("SNAPSHOT_POINTER_TARGET_MISMATCH");
    return fs.readFileSync(packed,"ascii").split(/\r?\n/).some(line=>new RegExp("^[a-f0-9]{64} "+store.ref(id)+"$").test(line));
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 65) fail("SNAPSHOT_POINTER_TARGET_MISMATCH");
  if (!/^[a-f0-9]{64}\n$/.test(fs.readFileSync(file, "ascii"))) fail("SNAPSHOT_POINTER_TARGET_MISMATCH");
  return true;
}

export class SnapshotBackendReclamation {
  constructor({ root, storage, signal, onProcess, deadline = Date.now() + 30_000, shouldContinue = () => true, collectionAttempt = null }) {
    this.root = root; this.storage = storage; this.base = path.join(root, storage.directory);
    this.store = new GitSnapshotStore({ projectRoot: root, storage, signal, onProcess });
    this.signal = signal; this.onProcess = onProcess; this.deadline = deadline; this.shouldContinue = shouldContinue; this.collectionAttempt = collectionAttempt;
    this.context = { deadline, signal }; this.refs = []; this.objects = new Map(); this.files = new Map(); this.domains = new Map();
    this.physicalEligible = true; this.decodedBytes = 0; this.storedBytes = 0; this.entryCount = 0;
  }
  selectSupervisor() {return resolveVerifiedProcessSupervisor({pluginRoot:path.resolve(import.meta.dirname,"../..")});}
  check() { if (this.signal?.aborted) fail("SNAPSHOT_GC_CANCELLED"); if (!this.shouldContinue()) fail("SNAPSHOT_COLLECTION_INVALIDATED"); if (Date.now() >= this.deadline) fail("SNAPSHOT_GIT_TIMEOUT"); }
  readFile(file, capture = false) {
    this.check(); safeSnapshotPath(this.root, file);
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_STORED)) fail("UNSAFE_GC_STORAGE_ENTRY");
    if (++this.entryCount > 50_000 || (this.storedBytes += Number(stat.size)) > MAX_STORED) fail("GC_INVENTORY_INCOMPLETE");
    const before = identity(stat); if(capture && stat.size>BigInt(SNAPSHOT_STORAGE_LIMITS.compressedBytes))fail("SNAPSHOT_STORAGE_LIMIT"); const bytes=capture?fs.readFileSync(file):null; const digest=bytes?sha(bytes):fileHash(file);
    if (!same(before, identity(fs.lstatSync(file, { bigint: true })))) fail("GC_INVENTORY_DRIFT");
    const row = { file, path: path.relative(this.root,file).replaceAll("\\", "/"), bytes: Number(stat.size), sha256: digest, identity: before };
    this.files.set(row.path, row); return { row, bytes };
  }
  async *inventoryGit() {
    if (!fs.existsSync(this.store.directory)) return;
    this.check(); this.store.checkOwner(this.deadline);
    const allowedRoot = new Set([".gitignore","HEAD","config","lode-owner.json","objects","refs","packed-refs","description","branches","hooks","info"]);
    for (const name of fs.readdirSync(this.store.directory)) if (!allowedRoot.has(name)) fail("UNSUPPORTED_GC_GIT_ENTRY");
    const head = fs.readFileSync(path.join(this.store.directory,"HEAD"),"ascii").trim();
    if (!/^ref: refs\/heads\/[A-Za-z0-9_-]+$/.test(head) || fs.existsSync(path.join(this.store.directory,head.slice(5)))) fail("UNSUPPORTED_GC_GIT_HEAD");
    for (const name of ["branches","hooks","info"]) { const file=path.join(this.store.directory,name); if(fs.existsSync(file)&&fs.readdirSync(file).length) fail("UNSUPPORTED_GC_GIT_ENTRY"); }
    if (fs.existsSync(path.join(this.store.directory,"packed-refs"))) this.physicalEligible = false;
    const walk = directory => { for (const name of fs.readdirSync(directory)) { const file=safeSnapshotPath(this.root,path.join(directory,name)), stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()) fail("UNSAFE_GC_STORAGE_ENTRY"); if(stat.isDirectory()) walk(file); else this.readFile(file); } };
    walk(path.join(this.store.directory,"objects")); walk(path.join(this.store.directory,"refs"));
    for (const row of this.files.values()) {
      const relative=path.relative(this.store.directory,row.file).replaceAll("\\","/");
      if (relative.startsWith("objects/") && !/^objects\/(?:[a-f0-9]{2}\/[a-f0-9]{62}|pack\/pack-[a-f0-9]{64}\.(?:pack|idx))$/.test(relative)) fail("UNSUPPORTED_GC_GIT_OBJECT_ENTRY");
      if(relative.endsWith(".pack")&&!fs.existsSync(row.file.slice(0,-5)+".idx")) await this.inventoryUnindexedPack(row);
      if(relative.endsWith(".idx")) {
        if(!fs.existsSync(row.file.slice(0,-4)+".pack")) fail("UNVERIFIED_GC_PACK_RESIDUE");
        await this.store.invoke(["verify-pack",row.file],this.context,{maxBytes:8192});
      }
    }
    const catalog = (await this.store.invoke(["cat-file","--batch-all-objects","--batch-check=%(objectname) %(objecttype) %(objectsize)"],this.context,{maxBytes:16*1024*1024})).toString("ascii").trim();
    for(const line of catalog ? catalog.split("\n") : []) {
      this.check(); const match=/^([a-f0-9]{64}) (tree|blob) ([0-9]+)$/.exec(line); if(!match) fail("UNSUPPORTED_GC_GIT_OBJECT");
      const size=Number(match[3]); if(!Number.isSafeInteger(size)||size>SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("SNAPSHOT_STORAGE_LIMIT");
      const raw=await this.store.object(match[1],match[2],size,this.context); this.decodedBytes+=raw.length;
      this.objects.set(match[1],{oid:match[1],type:match[2],size,rawSha256:sha(raw)});
      await new Promise(resolve=>setImmediate(resolve));
    }
    this.mainObjectIds=new Set([...this.objects.keys()].filter(oid=>!this.recoveredOnly?.has(oid)));
    // A recovered object also present in the ordinary catalog is main-readable.
    for(const line of catalog ? catalog.split("\n") : [])this.mainObjectIds.add(line.split(" ")[0]);
    const listing=(await this.store.invoke(["for-each-ref","--format=%(refname)%09%(objectname)%09%(symref)"],this.context,{maxBytes:16*1024*1024})).toString("ascii").trimEnd();
    for(const line of listing?listing.split("\n"):[]) {
      this.check(); const [ref,oid,symref]=line.split("\t"), match=REF.exec(ref);
      if(!match||!OID.test(oid)||symref) fail("UNSUPPORTED_GC_GIT_REF");
      const raw=await this.store.read(match[1],this.context); if(!raw||raw.snapshotStorage.treeObjectId!==oid) fail("GC_INVENTORY_DRIFT");
      const children=(await this.store.invoke(["ls-tree",oid],this.context,{maxBytes:4096})).toString("ascii").trim().split("\n").map(line=>/^100644 blob ([a-f0-9]{64})\t(?:metadata.json|snapshot.json)$/.exec(line)?.[1]);
      if(children.length!==2||children.some(x=>!x)||[oid,...children].some(id=>!this.objects.has(id))) fail("SNAPSHOT_GIT_TREE_INVALID");
      const entry=hydrateSnapshotEntry({root:this.root,storage:this.storage,entry:raw});
      const file=path.join(this.store.directory,ref), fileRow=this.files.get(path.relative(this.root,file).replaceAll("\\","/"));
      const row={id:match[1],ref,oid,objectIds:[oid,...children],refFile:fileRow||null,
        path:this.storage.directory+"/snapshot-objects.git#"+ref,bytes:0,backend:"git",document:entry.document,
        dependencies:entry.snapshotStorage.dependencies||[]};
      const {document,...summary}=row; this.refs.push(summary); yield row;
    }
    return;
  }
  // Only a new explicit collection may inspect an unindexed representation.
  // Ownership and format prove a supported private representation, not which
  // earlier operation produced it. No main index/ref is repaired or replayed.
  async inventoryUnindexedPack(row) {
    const attempt=this.collectionAttempt;
    if(!attempt)fail("UNVERIFIED_GC_PACK_RESIDUE");
    this.check();this.store.checkOwner(this.deadline);
    withSnapshotCollectionUnlink(attempt,()=>{});
    const source=this.recheck(row), match=/^pack-([a-f0-9]{64})\.pack$/.exec(path.basename(source));
    if(!match||row.bytes<44)fail("UNVERIFIED_GC_PACK_RESIDUE");
    const fd=fs.openSync(source,"r"),head=Buffer.alloc(12),tail=Buffer.alloc(32);
    let scratch=null,primaryError=null;
    try {
      if(!same(row.identity,identity(fs.fstatSync(fd,{bigint:true}))))fail("GC_INVENTORY_DRIFT");
      fs.readSync(fd,head,0,12,0);fs.readSync(fd,tail,0,32,row.bytes-32);
      if(head.toString("ascii",0,4)!=="PACK"||![2,3].includes(head.readUInt32BE(4))||tail.toString("hex")!==match[1])fail("UNVERIFIED_GC_PACK_RESIDUE");
      const count=head.readUInt32BE(8),reserve=1096+48*count,metadataBytes=64*1024+4096;
      // Recovery scratches are strictly sequential and removed before the next
      // residue or producer starts. Their combined live bytes, index reserve
      // and control/metadata share the same cap and whole-collection deadline.
      if(row.bytes+reserve+metadataBytes>MAX_STORED)fail("GC_STAGING_BYTE_LIMIT");
      const staging=safeSnapshotPath(this.root,path.join(attempt.ns.directory,"staging"));if(!fs.existsSync(staging))fs.mkdirSync(staging);
      // Reuse the short attempt-local slot only after the preceding inventory
      // has removed it. No producer is live concurrently. Assign ownership
      // only after mkdir succeeds, so a collision never cleans someone else's
      // directory. Keep the same path depth as the existing pack producer.
      const slot=safeSnapshotPath(this.root,path.join(staging,attempt.nonce));fs.mkdirSync(slot);scratch=slot;
      const packDir=path.join(scratch,"objects","pack");fs.mkdirSync(packDir,{recursive:true});fs.mkdirSync(path.join(scratch,"refs"));
      fs.writeFileSync(path.join(scratch,"HEAD"),"ref: refs/heads/unborn\n");fs.writeFileSync(path.join(scratch,"config"),"[core]\n repositoryformatversion = 1\n bare = true\n[extensions]\n objectformat = sha256\n");
      const pack=path.join(packDir,"new.pack"),idx=path.join(packDir,"new.idx"),out=fs.openSync(pack,"wx"),buffer=Buffer.alloc(64*1024),digest=crypto.createHash("sha256");
      try {
        let offset=0;
        while(offset<row.bytes){this.check();const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,row.bytes-offset),offset);if(!n)fail("GC_INVENTORY_DRIFT");
          const body=Math.min(n,Math.max(0,row.bytes-32-offset));if(body)digest.update(buffer.subarray(0,body));
          let written=0;while(written<n){this.check();if(offset+n+reserve+metadataBytes>MAX_STORED)fail("GC_STAGING_BYTE_LIMIT");const size=fs.writeSync(out,buffer,written,n-written);if(size<=0)fail("GC_STAGING_WRITE_FAILED");written+=size;}offset+=n;
          await new Promise(resolve=>setImmediate(resolve));
        }
        fs.fsyncSync(out);
      } finally {fs.closeSync(out);}
      if(digest.digest("hex")!==match[1]||!same(row.identity,identity(fs.fstatSync(fd,{bigint:true}))))fail("UNVERIFIED_GC_PACK_RESIDUE");this.recheck(row);
      const isolated=new GitSnapshotStore({projectRoot:this.root,storage:this.storage,signal:this.signal,onProcess:this.onProcess});isolated.directory=scratch;
      isolated.invoke=(args,context,options={})=>this.supervisedCommand(args,options.input===undefined?Buffer.alloc(0):Buffer.from(options.input),null,options.maxBytes??SNAPSHOT_STORAGE_LIMITS.decodedBytes,isolated);
      await isolated.invoke(["index-pack","--index-version=2","--no-rev-index","--threads=1","-o",idx,pack],this.context,{maxBytes:8192});
      if(fs.statSync(idx).size>reserve||fs.readdirSync(packDir).some(name=>![path.basename(pack),path.basename(idx)].includes(name)))fail("GC_STAGING_BYTE_LIMIT");
      const indexHeader=Buffer.alloc(8),indexFd=fs.openSync(idx,"r");try{fs.readSync(indexFd,indexHeader,0,8,0);}finally{fs.closeSync(indexFd);}if(indexHeader.readUInt32BE(0)!==0xff744f63||indexHeader.readUInt32BE(4)!==2)fail("UNSUPPORTED_GC_INDEX_PROFILE");
      await isolated.invoke(["verify-pack",idx],this.context,{maxBytes:8192});
      const text=(await isolated.invoke(["cat-file","--batch-all-objects","--batch-check=%(objectname) %(objecttype) %(objectsize)"],this.context,{maxBytes:16*1024*1024})).toString("ascii").trim(),recovered=new Map();
      for(const line of text?text.split("\n"):[]){this.check();const object=/^([a-f0-9]{64}) (tree|blob) ([0-9]+)$/.exec(line);if(!object)fail("UNSUPPORTED_GC_GIT_OBJECT");const size=Number(object[3]);if(!Number.isSafeInteger(size)||size>SNAPSHOT_STORAGE_LIMITS.decodedBytes)fail("SNAPSHOT_STORAGE_LIMIT");
        const raw=await isolated.object(object[1],object[2],size,this.context);this.decodedBytes+=raw.length;recovered.set(object[1],{oid:object[1],type:object[2],size,rawSha256:sha(raw)});
      }
      if(recovered.size!==count)fail("GC_STAGED_PACK_COVERAGE");
      // Validate every snapshot tree's metadata, Project and raw digest even
      // when the physical representation no longer has a live ref.
      isolated.checkOwner=()=>this.store.checkOwner(this.deadline);
      for(const object of recovered.values())if(object.type==="tree"){
        const listing=(await isolated.invoke(["ls-tree",object.oid],this.context,{maxBytes:4096})).toString("ascii").trim().split("\n"),entries=listing.map(line=>/^100644 blob ([a-f0-9]{64})\t(metadata.json|snapshot.json)$/.exec(line));
        if(entries.length!==2||entries.some(entry=>!entry)||new Set(entries.map(entry=>entry[2])).size!==2)fail("SNAPSHOT_GIT_TREE_INVALID");
        const metadataEntry=entries.find(entry=>entry[2]==="metadata.json"),metadata=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await isolated.object(metadataEntry[1],"blob",4096,this.context)));
        this.store.ref(metadata.snapshotId);
        const entry=hydrateSnapshotEntry({root:this.root,storage:this.storage,entry:await isolated.readExactTree(metadata.snapshotId,object.oid,this.context)});
        // Physical integrity does not establish a supported original schema.
        // Load the existing validators after module initialization (World's
        // adapters also use this helper); do not invent a parallel verifier.
        if(metadata.snapshotId.startsWith("world-model-")){
          const {verifyWorldModelSnapshotOriginal}=await import("./world-model.mjs");
          verifyWorldModelSnapshotOriginal({document:entry.document,worldModelId:metadata.snapshotId,storage:this.storage});
        }else{
          const {verifyTemporalProvenanceGraph}=await import("./temporal-provenance.mjs");
          verifyTemporalProvenanceGraph(entry.document);
        }
      }
      this.recoveredOnly??=new Set();for(const [oid,object] of recovered){const existing=this.objects.get(oid);if(existing&&stable(existing)!==stable(object))fail("SNAPSHOT_GIT_OBJECT_DIGEST_MISMATCH");this.objects.set(oid,object);this.recoveredOnly.add(oid);}
    } catch(error){primaryError=error;throw error;} finally {
      fs.closeSync(fd);
      try{if(scratch&&fs.existsSync(scratch)){safeSnapshotPath(this.root,scratch);fs.rmSync(scratch,{recursive:true});}}catch(error){if(primaryError)primaryError.snapshotStagingCleanup={code:error.code,path:scratch};else throw error;}
    }
  }
  async inventoryDomains() {
    const directory=safeSnapshotPath(this.root,path.join(this.base,"snapshot-bundles"));
    if(!fs.existsSync(directory))return;
    const producer={name:"lode-domain-bundle",version:"0.1.0"};
    for(const name of fs.readdirSync(directory).sort()) {
      const match=/^([a-f0-9]{64})\.json\.(gz|zst)$/.exec(name); if(!match)fail("UNSUPPORTED_GC_DOMAIN_ENTRY");
      const {row,bytes}=this.readFile(path.join(directory,name),true); if(bytes.length>SNAPSHOT_STORAGE_LIMITS.compressedBytes)fail("SNAPSHOT_STORAGE_LIMIT");
      let raw; if(match[2]==="gz")raw=zlib.gunzipSync(bytes,{maxOutputLength:SNAPSHOT_STORAGE_LIMITS.decodedBytes});
      else if(zlib.zstdDecompressSync)raw=zlib.zstdDecompressSync(bytes,{maxOutputLength:SNAPSHOT_STORAGE_LIMITS.decodedBytes});else fail("SNAPSHOT_BUNDLE_CODEC_UNAVAILABLE");
      this.decodedBytes+=raw.length; if(sha(raw)!==match[1])fail("SNAPSHOT_BUNDLE_DIGEST_MISMATCH");
      const doc=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw));
      if(doc.kind!=="SnapshotDomainBundle"||doc.schemaVersion!==1||doc.projectId!==this.storage.projectId||stable(doc.producer)!==stable(producer)||!doc.payload)fail("SNAPSHOT_BUNDLE_TYPE_MISMATCH");
      const keys={"graph-code":["nodes","edges"],"world-code":["files","semanticGraph","analysisBasis","domainBasis","rules","sourceScope"],"graph-composition":["body","code","otherNodes","otherEdges","nodeOrder","edgeOrder"]}[doc.domain];
      if(!keys||JSON.stringify(Object.keys(doc.payload).sort())!==JSON.stringify(keys.sort()))fail("UNSUPPORTED_GC_DOMAIN_SCHEMA");
      if(doc.domain==="graph-code"&&(!Array.isArray(doc.payload.nodes)||!Array.isArray(doc.payload.edges))||doc.domain==="world-code"&&!Array.isArray(doc.payload.files)||doc.domain==="graph-composition"&&(doc.payload.code?.domain!=="graph-code"||![doc.payload.otherNodes,doc.payload.otherEdges,doc.payload.nodeOrder,doc.payload.edgeOrder].every(Array.isArray)||[...doc.payload.nodeOrder,...doc.payload.edgeOrder].some(value=>typeof value!=="boolean")))fail("UNSUPPORTED_GC_DOMAIN_SCHEMA");
      const dependencies=doc.domain==="graph-composition"?[doc.payload.code]:[];
      this.domains.set(row.path,{...row,domain:doc.domain,rawSha256:match[1],byteLength:raw.length,encoding:match[2]==="gz"?"gzip":"zstd",dependencies});
      await new Promise(resolve=>setImmediate(resolve));this.check();
    }
    for(const row of this.domains.values())for(const ref of row.dependencies)this.verifyDomainRef(ref);
  }
  verifyDomainRef(ref) {
    const row=this.domains.get(ref?.address); if(!row||ref.kind!=="SnapshotDomainBundle"||ref.schemaVersion!==1||ref.projectId!==this.storage.projectId||ref.domain!==row.domain||ref.sha256!==row.rawSha256||ref.byteLength!==row.byteLength||ref.encoding!==row.encoding||stable(ref.producer)!==stable({name:"lode-domain-bundle",version:"0.1.0"}))fail("INVALID_SNAPSHOT_BUNDLE_REFERENCE"); return row;
  }
  recheck(row) {
    const file=safeSnapshotPath(this.root,row.file), stat=fs.lstatSync(file,{bigint:true});
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||!same(row.identity,identity(stat)))fail("SNAPSHOT_GC_CANDIDATE_DRIFT");
    return file;
  }
  retireRef(row,attempt) {
    this.check(); if(!this.physicalEligible||!row.refFile)fail("UNSUPPORTED_GC_PACKED_REFS");
    return withSnapshotCollectionUnlink(attempt,claim=>{
      const locks=[];
      try {
        for(const file of [row.refFile.file+".lock",path.join(this.store.directory,"packed-refs.lock")]) {
          safeSnapshotPath(this.root,file); const fd=fs.openSync(file,"wx");
          const lock={file,fd,identity:identity(fs.fstatSync(fd,{bigint:true}))}; locks.push(lock);
          fs.writeFileSync(fd,JSON.stringify({schemaVersion:claim.schemaVersion,nonce:claim.nonce,projectId:claim.projectId,
            host:claim.host,pid:claim.pid,processBirth:claim.processBirth,processBirthBasis:claim.processBirthBasis,createdAt:new Date().toISOString()}));
          fs.closeSync(fd); lock.fd=null;lock.identity=identity(fs.lstatSync(file,{bigint:true}));
        }
        this.check(); if(fs.existsSync(path.join(this.store.directory,"packed-refs")))fail("UNSUPPORTED_GC_PACKED_REFS");
        const file=this.recheck(row.refFile); if(fs.readFileSync(file,"ascii")!==row.oid+"\n")fail("SNAPSHOT_GC_REF_CAS_MISMATCH");
        for(const lock of locks)if(!same(lock.identity,identity(fs.lstatSync(lock.file,{bigint:true}))))fail("SNAPSHOT_GC_LOCK_CHANGED");
        fs.unlinkSync(file);return row.refFile;
      } finally { for(const lock of locks.reverse()){if(lock.fd!==null)fs.closeSync(lock.fd); if(fs.existsSync(lock.file)&&same(lock.identity,identity(fs.lstatSync(lock.file,{bigint:true}))))fs.unlinkSync(lock.file);} }
    });
  }
  unlink(row,attempt) { this.check();return withSnapshotCollectionUnlink(attempt,()=>{this.check();fs.unlinkSync(this.recheck(row));return row;}); }

  // Non-destructive Git producer with bounded disk streaming. Other commands
  // use the same sanitized GitSnapshotStore runner; the total deadline is shared.
  async packStream(oids,file,maxBytes) {
    return this.supervisedCommand(["pack-objects","--stdout","--threads=1","--window-memory=64m"],Buffer.from(oids.join("\n")+"\n"),file,maxBytes,this.store);
  }
  async supervisedCommand(gitArgs,input,file,maxBytes,store) {
    this.check();const nullFile=process.platform==="win32"?"NUL":"/dev/null";
    const env={};for(const key of ["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","COMSPEC","PATHEXT"])if(process.env[key])env[key]=process.env[key];
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:nullFile,GIT_TERMINAL_PROMPT:"0",GIT_NO_LAZY_FETCH:"1",GIT_NO_REPLACE_OBJECTS:"1",GIT_OPTIONAL_LOCKS:"0",LC_ALL:"C"});
    const args=["--no-pager","--no-replace-objects","--git-dir="+store.directory,"-c","core.hooksPath="+nullFile,"-c","gc.auto=0","-c","maintenance.auto=false","-c","protocol.allow=never",...gitArgs];
    const evidence={command:this.store.gitCommand,args,cwd:this.root,ports:[],parentPid:process.pid,startedAt:new Date().toISOString()};
    const selection=this.selectSupervisor();
    const executable=path.isAbsolute(this.store.gitCommand)?this.store.gitCommand:(env.PATH||env.Path||"").split(path.delimiter).map(directory=>path.join(directory,process.platform==="win32"?"git.exe":"git")).find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
    if(!executable)fail("SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE");
    const controlDirectory=file?path.dirname(file):store.directory;
    const controlFile=path.join(controlDirectory,"supervisor-"+crypto.randomUUID()+".jsonl");
    const actualEvidence={...evidence,command:selection.binaryPath,args:[],providerExecution:{executable,args,cwd:this.root}};
    this.onProcess?.({event:"planned",...actualEvidence});
    return new Promise((resolve,reject)=>{
      const fd=file?fs.openSync(file,"wx"):null;let supervised;const chunks=[],errors=[];let providerExitCode=null;
      try {supervised=spawnSupervisedProcess({selection,executablePath:executable,args,cwd:this.root,providerEnvironment:env,input,controlFile,terminationGraceMs:250,onControlEvent:event=>{if(event.type==="provider.exited")providerExitCode=event.exitCode;try{this.onProcess?.({event:"supervisor-control",...event,parentPid:supervised?.child.pid||null,command:executable,args,cwd:this.root,ports:[],observedAt:new Date().toISOString()});}catch{}}});}catch(error){if(fd!==null)fs.closeSync(fd);reject(error);return;}
      const child=supervised.child;actualEvidence.pid=child.pid||null;let bytes=0,failure=null,stderrBytes=0,escalate;
      const stop=code=>{failure??=Object.assign(new Error(code),{code});supervised.terminate(false);escalate??=setTimeout(()=>supervised.terminate(true),250);};
      const timer=setInterval(()=>{try{this.check();}catch(error){stop(error.code);}},20);
      child.stdout.on("data",chunk=>{child.stdout.pause();try{if(bytes+chunk.length>maxBytes)stop("GC_STAGING_BYTE_LIMIT");else if(!failure){if(fd===null){chunks.push(chunk);bytes+=chunk.length;}else{let offset=0;while(offset<chunk.length){const n=fs.writeSync(fd,chunk,offset,chunk.length-offset);if(n<=0)fail("GC_STAGING_WRITE_FAILED");offset+=n;bytes+=n;}}}}catch(error){failure??=error;stop(error.code||"GC_STAGING_WRITE_FAILED");}finally{child.stdout.resume();}});
      child.stderr.on("data",chunk=>{stderrBytes+=chunk.length;if(stderrBytes<=8192)errors.push(chunk);});child.stdin.on("error",error=>{if(error.code!=="EPIPE")failure??=error;});
      child.on("error",error=>{failure??=error;});
      child.once("close",(code,signal)=>{clearInterval(timer);clearTimeout(escalate);if(fd!==null){try{fs.fsyncSync(fd);}catch(error){failure??=error;}fs.closeSync(fd);}
        const supervision=supervised.finalize({exactSupervisorExitObserved:child.exitCode!==null||child.signalCode!==null,terminationRequested:failure!==null});
        if(!supervision.ownershipEstablished||!supervision.providerChildStarted||!supervision.treeCleanupVerified||supervision.controlInvalid){failure??=Object.assign(new Error("GC native process tree cleanup was not verified"),{code:"GC_PROCESS_TREE_CLEANUP_UNVERIFIED"});failure.nativeProcessCleanup={supervisorPid:actualEvidence.pid,providerPid:supervision.providerPid,...supervision};}
        try{this.onProcess?.({event:"closed",...actualEvidence,exitCode:code,signal,outputBytes:bytes,stderrBytes,supervision,failureCode:failure?.code||null});}catch{}
        try{if(fs.existsSync(controlFile))fs.unlinkSync(controlFile);}catch(error){failure??=error;}
        if(failure){if(fd!==null)failure.writtenOutputBytes=bytes;reject(failure);}else if(code!==0||providerExitCode!==0)reject(Object.assign(new Error("SNAPSHOT_GIT_COMMAND_FAILED"),{code:"SNAPSHOT_GIT_COMMAND_FAILED",gitStderr:Buffer.concat(errors).toString("utf8"),writtenOutputBytes:fd!==null?bytes:undefined}));else resolve(fd===null?Buffer.concat(chunks):bytes);
      });
      try{this.onProcess?.({event:"started",...actualEvidence});}catch{}
    });
  }
  async reclaim({attempt,result,remainingSnapshots,pinnedOids=new Set(),pinnedPaths=new Set()}) {
    const keepDomains=new Set(), keepObjects=new Set(pinnedOids);
    const retainDomain=ref=>{const row=this.verifyDomainRef(ref);if(keepDomains.has(row.path))return;keepDomains.add(row.path);for(const child of row.dependencies)retainDomain(child);};
    for(const row of remainingSnapshots){for(const id of row.objectIds||[])keepObjects.add(id);for(const dep of row.dependencies||[])retainDomain(dep);}
    for(const p of pinnedPaths)if(this.domains.has(p)){const row=this.domains.get(p);retainDomain({kind:"SnapshotDomainBundle",schemaVersion:1,projectId:this.storage.projectId,producer:{name:"lode-domain-bundle",version:"0.1.0"},address:p,domain:row.domain,sha256:row.rawSha256,byteLength:row.byteLength,encoding:row.encoding});}
    // A raw unbound object pin may embed a composition. Without its typed
    // owner proof preserve all fragments rather than infer absence.
    if([...pinnedOids].some(id=>!remainingSnapshots.some(row=>row.objectIds?.includes(id))))for(const p of this.domains.keys())keepDomains.add(p);
    if(fs.existsSync(this.store.directory)&&this.physicalEligible)await this.reclaimObjects({attempt,result,keepObjects,pinnedPaths});
    else if(fs.existsSync(this.store.directory))result.deferred.push({scope:"git-objects",code:"UNSUPPORTED_GC_PACKED_REFS"});
    for(const row of this.domains.values())if(!keepDomains.has(row.path)&&!pinnedPaths.has(row.path)){this.check();this.unlink(row,attempt);this.recordDelete(result,row,"domain");await new Promise(resolve=>setImmediate(resolve));}
  }
  recordDelete(result,row,kind) {result.deleted.push({path:row.path,bytes:row.bytes,sha256:row.sha256,storageKind:kind});result.deletedCount++;result.reclaimedBytes+=row.bytes;result.applyPerformed=true;if(kind==="domain")result.deletedDomainBundles++;else if(kind==="git-object")result.deletedObjectFiles++;}
  async reclaimObjects({attempt,result,keepObjects,pinnedPaths}) {
    this.check();if([...keepObjects].some(id=>!this.objects.has(id)))fail("GC_RETAINED_GIT_OBJECT_UNAVAILABLE");
    // Closure has already proved these exact pins. Main DB availability is a
    // separate physical producer condition; never install an index to repair it.
    if([...keepObjects].some(id=>this.recoveredOnly?.has(id)&&!this.mainObjectIds?.has(id))){result.deferred.push({scope:"git-objects",code:"GC_RETAINED_GIT_OBJECT_NOT_MAIN_READABLE"});return;}
    // Every supported tree is a two-blob snapshot tree. Explicit raw tree pins
    // retain the referenced blobs too, even without a surviving physical ref.
    for(const oid of [...keepObjects])if(this.objects.get(oid).type==="tree"){
      const text=(await this.store.invoke(["ls-tree",oid],this.context,{maxBytes:4096})).toString("ascii").trim();
      for(const line of text.split("\n")){const match=/^100644 blob ([a-f0-9]{64})\t(?:metadata.json|snapshot.json)$/.exec(line);if(!match||!this.objects.has(match[1]))fail("UNSUPPORTED_GC_GIT_TREE");keepObjects.add(match[1]);}
    }
    const oldFiles=[...this.files.values()].filter(row=>row.path.includes("/objects/"));
    if(oldFiles.some(row=>pinnedPaths.has(row.path))){result.deferred.push({scope:"git-objects",code:"EXACT_GIT_OBJECT_FILE_PIN"});return;}
    if(this.objects.size===keepObjects.size)return;
    if(keepObjects.size){try{this.selectSupervisor();}catch(error){if(error.code!=="PROCESS_SUPERVISOR_NOT_AVAILABLE")throw error;result.deferred.push({scope:"git-objects",code:error.code});return;}}
    let scratch=null,primaryError=null;const survivingPairs=new Set();
    try {
      if(keepObjects.size){
        const staging=safeSnapshotPath(this.root,path.join(attempt.ns.directory,"staging"));if(!fs.existsSync(staging))fs.mkdirSync(staging); const slot=safeSnapshotPath(this.root,path.join(staging,attempt.nonce));fs.mkdirSync(slot);scratch=slot;
        const packDir=path.join(scratch,"objects","pack");fs.mkdirSync(packDir,{recursive:true});fs.mkdirSync(path.join(scratch,"refs"));
        fs.writeFileSync(path.join(scratch,"HEAD"),"ref: refs/heads/unborn\n");fs.writeFileSync(path.join(scratch,"config"),"[core]\n repositoryformatversion = 1\n bare = true\n[extensions]\n objectformat = sha256\n");
        const oids=[...keepObjects].sort(), reserve=1096+48*oids.length, temporary=path.join(packDir,"new.pack"), metadataBytes=64*1024+4096;
        if(oids.length*65>4*1024*1024){result.deferred.push({scope:"git-objects",code:"GC_SUPERVISOR_INPUT_LIMIT"});return;}
        let written;try{written=await this.packStream(oids,temporary,MAX_STORED-reserve-metadataBytes);}catch(error){result.writtenPackBytes+=error.writtenOutputBytes||0;throw error;}result.writtenPackBytes+=written;
        this.check();const headerFd=fs.openSync(temporary,"r"),head=Buffer.alloc(12);try{fs.readSync(headerFd,head,0,12,0);}finally{fs.closeSync(headerFd);}if(head.toString("ascii",0,4)!=="PACK"||head.readUInt32BE(8)!==oids.length)fail("GC_STAGED_PACK_OBJECT_COUNT");
        const isolated=new GitSnapshotStore({projectRoot:this.root,storage:this.storage,signal:this.signal,onProcess:this.onProcess});isolated.directory=scratch;
        isolated.invoke=(args,context,options={})=>this.supervisedCommand(args,options.input===undefined?Buffer.alloc(0):Buffer.from(options.input),null,options.maxBytes??SNAPSHOT_STORAGE_LIMITS.decodedBytes,isolated);
        await isolated.invoke(["index-pack","--index-version=2","--no-rev-index","--threads=1","-o",path.join(packDir,"new.idx"),temporary],this.context,{maxBytes:8192});
        const idx=path.join(packDir,"new.idx");if(fs.statSync(idx).size>reserve)fail("GC_STAGING_BYTE_LIMIT");
        if(fs.readdirSync(packDir).some(name=>!["new.pack","new.idx"].includes(name)))fail("UNSUPPORTED_GC_STAGED_ENTRY");
        const indexFd=fs.openSync(idx,"r"),indexHeader=Buffer.alloc(8);try{fs.readSync(indexFd,indexHeader,0,8,0);}finally{fs.closeSync(indexFd);}if(indexHeader.readUInt32BE(0)!==0xff744f63||indexHeader.readUInt32BE(4)!==2)fail("UNSUPPORTED_GC_INDEX_PROFILE");
        await isolated.invoke(["verify-pack",idx],this.context,{maxBytes:8192});
        const actual=(await isolated.invoke(["cat-file","--batch-all-objects","--batch-check=%(objectname)"],this.context,{maxBytes:16*1024*1024})).toString("ascii").trim().split("\n").filter(Boolean).sort();
        if(JSON.stringify(actual)!==JSON.stringify(oids))fail("GC_STAGED_PACK_COVERAGE");
        for(const oid of oids){this.check();const original=this.objects.get(oid), bytes=await isolated.object(oid,original.type,original.size,this.context);if(sha(bytes)!==original.rawSha256)fail("GC_STAGED_PACK_RAW_MISMATCH");}
        const fd=fs.openSync(temporary,"r"),tail=Buffer.alloc(32);try{fs.readSync(fd,tail,0,32,written-32);}finally{fs.closeSync(fd);}
        const name="pack-"+tail.toString("hex"), finalPack=path.join(this.store.directory,"objects","pack",name+".pack"), finalIdx=finalPack.slice(0,-5)+".idx";
        const packSha=fileHash(temporary),idxSha=fileHash(idx);
        const existingPack=fs.existsSync(finalPack)?{identity:identity(fs.lstatSync(finalPack,{bigint:true})),hash:fileHash(finalPack)}:null,existingIdx=fs.existsSync(finalIdx)?{identity:identity(fs.lstatSync(finalIdx,{bigint:true})),hash:fileHash(finalIdx)}:null;
        withSnapshotCollectionUnlink(attempt,()=>{this.check();
          const p=fs.existsSync(finalPack),i=fs.existsSync(finalIdx);
          if(p&&!i){
            const original=this.files.get(path.relative(this.root,finalPack).replaceAll("\\","/"));
            if(!original||!existingPack||existingPack.hash!==packSha||!same(existingPack.identity,original.identity)||!same(existingPack.identity,identity(fs.lstatSync(finalPack,{bigint:true}))))fail("GC_PACK_PUBLICATION_CONFLICT");
            // Current closure and a fresh isolated producer proved this pair.
            // Reuse only the exact same pack; never publish a recovery index.
            const idxBytes=fs.statSync(idx).size;fs.renameSync(idx,finalIdx);result.publishedPackBytes+=idxBytes;result.applyPerformed=true;result.publishedFiles??=[];result.publishedFiles.push({path:path.relative(this.root,finalIdx).replaceAll("\\","/"),bytes:idxBytes,sha256:idxSha});
          }
          else if(p||i){if(!p||!i||!existingPack||!existingIdx||existingPack.hash!==packSha||existingIdx.hash!==idxSha||!same(existingPack.identity,identity(fs.lstatSync(finalPack,{bigint:true})))||!same(existingIdx.identity,identity(fs.lstatSync(finalIdx,{bigint:true}))))fail("GC_PACK_PUBLICATION_CONFLICT");}
          else {const idxBytes=fs.statSync(idx).size;result.publishedFiles??=[];fs.renameSync(temporary,finalPack);result.publishedPackBytes+=written;result.applyPerformed=true;result.publishedFiles.push({path:path.relative(this.root,finalPack).replaceAll("\\","/"),bytes:written,sha256:packSha});fs.renameSync(idx,finalIdx);result.publishedPackBytes+=idxBytes;result.publishedFiles.push({path:path.relative(this.root,finalIdx).replaceAll("\\","/"),bytes:idxBytes,sha256:idxSha});}
          survivingPairs.add(finalPack);survivingPairs.add(finalIdx);
        });
      }
      await new Promise(resolve=>setImmediate(resolve));this.check();
      const retire=oldFiles.filter(row=>!survivingPairs.has(row.file));
      // Index first: new readers discover only the surviving complete pair.
      retire.sort((a,b)=>Number(!a.file.endsWith(".idx"))-Number(!b.file.endsWith(".idx"))||a.file.localeCompare(b.file));
      for(const row of retire){this.check();const loose=/\/objects\/([a-f0-9]{2})\/([a-f0-9]{62})$/.exec(row.path);if(loose&&keepObjects.has(loose[1]+loose[2])&&!survivingPairs.size)continue;this.unlink(row,attempt);this.recordDelete(result,row,"git-object");await new Promise(resolve=>setImmediate(resolve));}
    } catch(error){primaryError=error;throw error;} finally {
      try{if(scratch&&fs.existsSync(scratch)){safeSnapshotPath(this.root,scratch);fs.rmSync(scratch,{recursive:true});}}catch(error){const detail={path:path.relative(this.root,scratch).replaceAll("\\","/"),code:error.code||"GC_STAGING_CLEANUP_FAILED"};if(primaryError)primaryError.snapshotStagingCleanup=detail;else{error.operationCompleted=result.applyPerformed===true;error.snapshotStagingCleanup=detail;throw error;}}
    }
  }
}
