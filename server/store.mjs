import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

const parse=row=>row?JSON.parse(row.data):null;
export class Store {
  constructor(filename) {
    if(filename!==':memory:')mkdirSync(path.dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),data TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),created_at TEXT NOT NULL,data TEXT NOT NULL);'+
      'CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);'+
      'CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),member_id TEXT,created_at TEXT NOT NULL,data TEXT NOT NULL);'+
      'CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id,created_at);'+
      'CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,data TEXT NOT NULL);'
    );
    // Interrupted work is visible after restart; it is never a successful result.
    for(const row of this.db.prepare('SELECT id,data FROM conversations').all()){
      const c=parse(row);if(c.status==='running'){c.status='paused';c.pauseReason='服务重启，讨论已暂停。';this.saveConversation(c);}
    }
    for(const row of this.db.prepare('SELECT id,data FROM messages').all()){
      const m=parse(row);if(m.status==='streaming'){m.status='interrupted';this.saveMessage(m);}
    }
  }
  listConversations(){return this.db.prepare('SELECT data FROM conversations ORDER BY updated_at DESC').all().map(parse);}
  conversation(id){return parse(this.db.prepare('SELECT data FROM conversations WHERE id=?').get(id));}
  createConversation({title='新会话',projectPath=null}={}){
    const now=new Date().toISOString();const c={id:randomUUID(),title,projectPath,status:'idle',contextVersion:1,candidate:null,result:null,pauseReason:null,createdAt:now,updatedAt:now};
    this.saveConversation(c);return c;
  }
  saveConversation(c){this.db.prepare('INSERT INTO conversations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(c.id,JSON.stringify(c),c.updatedAt);return c;}
  patchConversation(id,patch){const c=this.conversation(id);if(!c)throw new Error('会话不存在。');Object.assign(c,patch,{updatedAt:new Date().toISOString()});return this.saveConversation(c);}
  members(conversationId,{includeInactive=false}={}){return this.db.prepare('SELECT data FROM members WHERE conversation_id=?').all(conversationId).map(parse).filter(m=>includeInactive||m.active);}
  member(id){return parse(this.db.prepare('SELECT data FROM members WHERE id=?').get(id));}
  addMember(conversationId,input){if(!this.conversation(conversationId))throw new Error('会话不存在。');const m={id:randomUUID(),conversationId,active:true,localSession:null,createdAt:new Date().toISOString(),...input};this.saveMember(m);return m;}
  saveMember(m){this.db.prepare('INSERT INTO members VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(m.id,m.conversationId,JSON.stringify(m));return m;}
  patchMember(id,patch){const m=this.member(id);if(!m)throw new Error('参与者不存在。');return this.saveMember({...m,...patch});}
  messages(conversationId){return this.db.prepare('SELECT data FROM messages WHERE conversation_id=? ORDER BY created_at,rowid').all(conversationId).map(parse);}
  saveMessage(m){this.db.prepare('INSERT INTO messages VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(m.id,m.conversationId,m.createdAt,JSON.stringify(m));return m;}
  addMessage(conversationId,input){const m={id:randomUUID(),conversationId,createdAt:new Date().toISOString(),status:'complete',...input};return this.saveMessage(m);}
  event(conversationId,memberId,type,summary,detail={}){
    const e={id:randomUUID(),conversationId,memberId,type,summary,detail,createdAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(e.id,conversationId,memberId,e.createdAt,JSON.stringify(e));return e;
  }
  events(conversationId,memberId=null){const rows=memberId?this.db.prepare('SELECT data FROM events WHERE conversation_id=? AND member_id=? ORDER BY created_at,rowid').all(conversationId,memberId):this.db.prepare('SELECT data FROM events WHERE conversation_id=? ORDER BY created_at,rowid').all(conversationId);return rows.map(parse);}
  setting(id,fallback=null){return parse(this.db.prepare('SELECT data FROM settings WHERE id=?').get(id))??fallback;}
  saveSetting(id,data){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(data));return data;}
  workspace(id){const c=this.conversation(id);return c?{conversation:c,members:this.members(id),messages:this.messages(id),events:this.events(id)}:null;}
  close(){this.db.close();}
}
