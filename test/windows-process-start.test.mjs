import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {after, before, test} from 'node:test';
import {PeerEndpoint, listClaudeSessions, assertClaudeSessionProcess, peerKeyPath} from '../src/peer-protocol.mjs';

const windows=process.platform==='win32';
const saved={HOME:process.env.HOME,CODEX_BRIDGE_HARDENED:process.env.CODEX_BRIDGE_HARDENED};
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-process-identity-'));
const registry=path.join(scratch,'.claude','sessions');
const shell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const identity=windows?execFileSync(shell,['-NoProfile','-NonInteractive','-Command',`[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`],{windowsHide:true}).toString().trim():'';
const socket=`\\\\.\\pipe\\LOCAL\\bridge-identity-test-${process.pid}`;
before(()=>{process.env.HOME=scratch;process.env.CODEX_BRIDGE_HARDENED='1';fs.mkdirSync(registry,{recursive:true});});
after(()=>{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(scratch,{recursive:true,force:true});});
function writeEntry(fields){fs.writeFileSync(path.join(registry,`${process.pid}.json`),JSON.stringify({pid:process.pid,sessionId:'identity-test',cwd:scratch,messagingSocketPath:socket,...fields}));}
function discovered(){return listClaudeSessions({includeBridges:true}).find(x=>x.sessionId==='identity-test');}

test('Windows native procStart FILETIME is discovered and revalidated against the live OS process',{skip:!windows},()=>{
  writeEntry({procStart:identity});
  assert.equal(discovered().processStart,identity);
  assert.doesNotThrow(()=>assertClaudeSessionProcess(discovered()));
});
test('Windows legacy procStartFt and equal dual aliases remain supported',{skip:!windows},()=>{
  for(const fields of [{procStartFt:identity},{procStartFt:identity,procStart:identity}]){
    writeEntry(fields);assert.equal(discovered().processStart,identity);assert.doesNotThrow(()=>assertClaudeSessionProcess(discovered()));
  }
});
test('Missing, malformed, conflicting, and stale process identities cannot pass the send preflight',{skip:!windows},()=>{
  for(const fields of [{},{procStart:123},{procStart:''},{procStart:'0'},{procStart:' 123'},{procStart:'18446744073709551616'},{procStartFt:identity,procStart:'1'},{procStartFt:null,procStart:identity},{procStartFt:identity,procStart:null},{procStart:'1'},{procStartFt:'1'}]){
    writeEntry(fields);assert.throws(()=>assertClaudeSessionProcess(discovered()),/identity is missing or changed/);
  }
});
test('Native procStart key is authenticated; stale or conflicting key aliases fail before connecting',{skip:!windows},async()=>{
  writeEntry({procStart:identity});
  const keyFile=peerKeyPath(process.pid,socket),token='b'.repeat(32);
  let connections=0,received='';
  const server=net.createServer(client=>{connections++;client.on('data',data=>{received+=data.toString();});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  const sender=new PeerEndpoint({cwd:scratch});
  try{
    for(const fields of [{procStart:'1'},{procStartFt:identity,procStart:'1'},{procStart:null},{},{procStartFt:null,procStart:identity}]){
      fs.writeFileSync(keyFile,JSON.stringify({peerToken:token,...fields}));
      await assert.rejects(sender.send(socket,'must never be delivered'),/authentication key is missing or invalid/);
      assert.equal(connections,0);
    }
    fs.writeFileSync(keyFile,JSON.stringify({peerToken:token,procStart:identity}));
    await sender.send(socket,'native-alias-authenticated');
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(connections,1);assert.match(received,/native-alias-authenticated/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('Windows bridge publication supplies the same OS identity for old and current Claude peers',{skip:!windows},async()=>{
  const peer=new PeerEndpoint({cwd:scratch});
  try{
    await peer.start();
    for(const file of [peer.registryPath,peer.keyPath]){
      const record=JSON.parse(fs.readFileSync(file,'utf8'));
      assert.equal(record.procStart,identity);assert.equal(record.procStartFt,identity);
    }
  }finally{peer.stop();}
});
