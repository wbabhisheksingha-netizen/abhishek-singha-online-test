const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new sqlite3.Database(path.join(DB_DIR, 'exam.sqlite'));
const run = (sql, params=[]) => new Promise((resolve,reject)=>db.run(sql,params,function(e){e?reject(e):resolve(this)}));
const get = (sql, params=[]) => new Promise((resolve,reject)=>db.get(sql,params,(e,r)=>e?reject(e):resolve(r)));
const all = (sql, params=[]) => new Promise((resolve,reject)=>db.all(sql,params,(e,r)=>e?reject(e):resolve(r)));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:false, limit:'2mb'}));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DB_DIR }),
  secret: process.env.SESSION_SECRET || 'change-this-long-random-secret-before-deployment',
  resave:false, saveUninitialized:false,
  cookie:{ httpOnly:true, sameSite:'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8*60*60*1000 }
}));
app.use(express.static(path.join(__dirname,'public')));
app.use('/api/login', rateLimit({windowMs:15*60*1000, limit:20, standardHeaders:true, legacyHeaders:false}));

const schema = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS exams(id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', duration_minutes INTEGER NOT NULL DEFAULT 60, is_published INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS questions(id INTEGER PRIMARY KEY, exam_id INTEGER NOT NULL, body TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, c TEXT NOT NULL, d TEXT NOT NULL, correct TEXT NOT NULL CHECK(correct IN ('A','B','C','D')), explanation TEXT DEFAULT '', FOREIGN KEY(exam_id) REFERENCES exams(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY, exam_id INTEGER NOT NULL, user_id INTEGER NOT NULL, started_at TEXT NOT NULL, submitted_at TEXT, answers_json TEXT DEFAULT '{}', score INTEGER, correct_count INTEGER, wrong_count INTEGER, skipped_count INTEGER, UNIQUE(exam_id,user_id), FOREIGN KEY(exam_id) REFERENCES exams(id), FOREIGN KEY(user_id) REFERENCES users(id));
`;

async function init(){
  await run('PRAGMA foreign_keys = ON');
  for(const s of schema.split(';').map(x=>x.trim()).filter(Boolean)) await run(s);
  const adminName = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD;
  if(!adminPass){ console.warn('ADMIN_PASSWORD is not set. Set it before allowing public access.'); }
  else {
    const existing = await get('SELECT id FROM users WHERE username=?',[adminName]);
    if(!existing) await run('INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,?)',[adminName,'Administrator',await bcrypt.hash(adminPass,12),'admin']);
  }
}
const safeUser = u => ({id:u.id,username:u.username,name:u.name,role:u.role});
function auth(req,res,next){ if(!req.session.user) return res.status(401).json({error:'Please log in.'}); next(); }
function admin(req,res,next){ if(!req.session.user || req.session.user.role!=='admin') return res.status(403).json({error:'Admin access required.'}); next(); }
function student(req,res,next){ if(!req.session.user || req.session.user.role!=='student') return res.status(403).json({error:'Student access required.'}); next(); }

app.get('/api/me',(req,res)=>res.json({user:req.session.user||null}));
app.post('/api/login',async(req,res)=>{
  const {username,password}=req.body||{};
  if(!username||!password) return res.status(400).json({error:'Enter username and password.'});
  const u=await get('SELECT * FROM users WHERE username=?',[String(username).trim()]);
  if(!u || !(await bcrypt.compare(String(password),u.password_hash))) return res.status(401).json({error:'Incorrect username or password.'});
  req.session.regenerate(err=>{ if(err) return res.status(500).json({error:'Could not start session.'}); req.session.user=safeUser(u); res.json({user:req.session.user}); });
});
app.post('/api/logout',auth,(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get('/api/student/exams',auth,async(req,res)=>{
  const exams=await all(`SELECT e.id,e.title,e.description,e.duration_minutes,
    (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) question_count,
    (SELECT id FROM attempts a WHERE a.exam_id=e.id AND a.user_id=? AND a.submitted_at IS NOT NULL) completed
    FROM exams e WHERE e.is_published=1 ORDER BY e.created_at DESC`,[req.session.user.id]);
  res.json({exams});
});
app.post('/api/student/exams/:id/start',student,async(req,res)=>{
  const exam=await get('SELECT * FROM exams WHERE id=? AND is_published=1',[req.params.id]);
  if(!exam) return res.status(404).json({error:'Exam not found or not published.'});
  let attempt=await get('SELECT * FROM attempts WHERE exam_id=? AND user_id=?',[exam.id,req.session.user.id]);
  if(attempt?.submitted_at) return res.status(409).json({error:'You have already submitted this exam.'});
  if(!attempt){ const started=new Date().toISOString(); const r=await run('INSERT INTO attempts(exam_id,user_id,started_at) VALUES(?,?,?)',[exam.id,req.session.user.id,started]); attempt=await get('SELECT * FROM attempts WHERE id=?',[r.lastID]); }
  const questions=await all('SELECT id,body,a,b,c,d FROM questions WHERE exam_id=? ORDER BY id',[exam.id]);
  res.json({exam:{id:exam.id,title:exam.title,duration_minutes:exam.duration_minutes},attempt:{id:attempt.id,started_at:attempt.started_at,answers:JSON.parse(attempt.answers_json||'{}')},questions});
});
app.post('/api/student/attempts/:id/answer',student,async(req,res)=>{
  const attempt=await get('SELECT * FROM attempts WHERE id=? AND user_id=?',[req.params.id,req.session.user.id]);
  if(!attempt||attempt.submitted_at) return res.status(409).json({error:'Attempt is not active.'});
  const activeExam=await get('SELECT duration_minutes FROM exams WHERE id=?',[attempt.exam_id]);
  if(Date.now()>new Date(attempt.started_at).getTime()+activeExam.duration_minutes*60000) return res.status(409).json({error:'Time is over. Submit your examination.'});
  const {questionId,choice}=req.body||{};
  if(!['A','B','C','D',null].includes(choice)) return res.status(400).json({error:'Invalid answer.'});
  const q=await get('SELECT id FROM questions WHERE id=? AND exam_id=?',[questionId,attempt.exam_id]);
  if(!q) return res.status(400).json({error:'Question does not belong to this exam.'});
  const answers=JSON.parse(attempt.answers_json||'{}');
  if(choice===null) delete answers[questionId]; else answers[questionId]=choice;
  await run('UPDATE attempts SET answers_json=? WHERE id=?',[JSON.stringify(answers),attempt.id]);
  res.json({ok:true});
});
app.post('/api/student/attempts/:id/submit',student,async(req,res)=>{
  const attempt=await get('SELECT * FROM attempts WHERE id=? AND user_id=?',[req.params.id,req.session.user.id]);
  if(!attempt) return res.status(404).json({error:'Attempt not found.'});
  if(attempt.submitted_at) return res.json({ok:true,alreadySubmitted:true});
  const exam=await get('SELECT * FROM exams WHERE id=?',[attempt.exam_id]);
  const deadline=new Date(attempt.started_at).getTime()+exam.duration_minutes*60000;
  const questions=await all('SELECT id,correct FROM questions WHERE exam_id=?',[attempt.exam_id]);
  const answers=JSON.parse(attempt.answers_json||'{}');
  let correct=0,wrong=0,skipped=0;
  for(const q of questions){const a=answers[q.id]; if(!a) skipped++; else if(a===q.correct) correct++; else wrong++;}
  const score=correct*4-wrong;
  await run('UPDATE attempts SET submitted_at=?,score=?,correct_count=?,wrong_count=?,skipped_count=? WHERE id=?',[new Date().toISOString(),score,correct,wrong,skipped,attempt.id]);
  res.json({ok:true,score,correct,wrong,skipped,total:questions.length,late:Date.now()>deadline});
});
app.get('/api/student/results',student,async(req,res)=>{
  const rows=await all(`SELECT a.id,a.score,a.correct_count,a.wrong_count,a.skipped_count,a.submitted_at,e.title,e.id exam_id
    FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.user_id=? AND a.submitted_at IS NOT NULL ORDER BY a.submitted_at DESC`,[req.session.user.id]);
  for(const r of rows){ const rank=await get(`SELECT COUNT(*)+1 rank FROM attempts WHERE exam_id=? AND submitted_at IS NOT NULL AND score>?`,[r.exam_id,r.score]); r.rank=rank.rank; }
  res.json({results:rows});
});
app.get('/api/student/leaderboard/:examId',student,async(req,res)=>{
  const rows=await all(`SELECT u.name,u.username,a.score,a.correct_count,a.wrong_count,a.skipped_count,a.submitted_at FROM attempts a JOIN users u ON u.id=a.user_id WHERE a.exam_id=? AND a.submitted_at IS NOT NULL ORDER BY a.score DESC,a.submitted_at ASC LIMIT 100`,[req.params.examId]);
  res.json({leaderboard:rows.map((r,i)=>({...r,rank:i+1,mine:r.username===req.session.user.username}))});
});

app.get('/api/admin/overview',admin,async(req,res)=>{
  const students=await get("SELECT COUNT(*) count FROM users WHERE role='student'");
  const exams=await get('SELECT COUNT(*) count FROM exams');
  const attempts=await get('SELECT COUNT(*) count FROM attempts WHERE submitted_at IS NOT NULL');
  res.json({students:students.count,exams:exams.count,submissions:attempts.count,studentLimit:100});
});
app.get('/api/admin/exams',admin,async(req,res)=>res.json({exams:await all(`SELECT e.*,(SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) question_count FROM exams e ORDER BY e.created_at DESC`)}));
app.post('/api/admin/exams',admin,async(req,res)=>{
  const {title,description,duration_minutes}=req.body||{};
  if(!title||!Number.isInteger(Number(duration_minutes))||Number(duration_minutes)<1) return res.status(400).json({error:'Enter an exam title and valid duration.'});
  const r=await run('INSERT INTO exams(title,description,duration_minutes) VALUES(?,?,?)',[title,description||'',Number(duration_minutes)]);
  res.json({id:r.lastID});
});
app.post('/api/admin/exams/:id/publish',admin,async(req,res)=>{
  const count=await get('SELECT COUNT(*) count FROM questions WHERE exam_id=?',[req.params.id]);
  if(!count.count) return res.status(400).json({error:'Add at least one question before publishing.'});
  await run('UPDATE exams SET is_published=1 WHERE id=?',[req.params.id]); res.json({ok:true});
});
app.post('/api/admin/exams/:id/unpublish',admin,async(req,res)=>{await run('UPDATE exams SET is_published=0 WHERE id=?',[req.params.id]);res.json({ok:true});});
app.post('/api/admin/exams/:id/questions',admin,async(req,res)=>{
  const exam=await get('SELECT id FROM exams WHERE id=?',[req.params.id]); if(!exam)return res.status(404).json({error:'Exam not found.'});
  const items=Array.isArray(req.body.questions)?req.body.questions:[req.body];
  if(!items.length||items.length>500) return res.status(400).json({error:'Upload between 1 and 500 questions at a time.'});
  for(const q of items){
    const correct=String(q.correct||'').toUpperCase();
    if(!q.body||!q.a||!q.b||!q.c||!q.d||!['A','B','C','D'].includes(correct)) return res.status(400).json({error:'Each question needs text, four options and correct answer A/B/C/D.'});
  }
  for(const q of items) await run('INSERT INTO questions(exam_id,body,a,b,c,d,correct,explanation) VALUES(?,?,?,?,?,?,?,?)',[req.params.id,q.body,q.a,q.b,q.c,q.d,String(q.correct).toUpperCase(),q.explanation||'']);
  res.json({added:items.length});
});
app.post('/api/admin/exams/:id/import-csv',admin,async(req,res)=>{
  try{
    const records=parse(String(req.body.csv||''),{columns:true,skip_empty_lines:true,trim:true,bom:true});
    const items=records.map(r=>({body:r.question||r.body,a:r.A||r.a,b:r.B||r.b,c:r.C||r.c,d:r.D||r.d,correct:r.correct,explanation:r.explanation||''}));
    req.body.questions=items;
    const exam=await get('SELECT id FROM exams WHERE id=?',[req.params.id]);if(!exam)return res.status(404).json({error:'Exam not found.'});
    if(!items.length||items.length>500) return res.status(400).json({error:'CSV must contain 1–500 questions.'});
    for(const q of items) if(!q.body||!q.a||!q.b||!q.c||!q.d||!['A','B','C','D'].includes(String(q.correct).toUpperCase())) return res.status(400).json({error:'CSV columns required: question,A,B,C,D,correct. Check every row.'});
    for(const q of items) await run('INSERT INTO questions(exam_id,body,a,b,c,d,correct,explanation) VALUES(?,?,?,?,?,?,?,?)',[req.params.id,q.body,q.a,q.b,q.c,q.d,String(q.correct).toUpperCase(),q.explanation]);
    res.json({added:items.length});
  }catch(e){res.status(400).json({error:'Could not read CSV. Use a valid CSV with headers question,A,B,C,D,correct,explanation.'});}
});
app.get('/api/admin/exams/:id/questions',admin,async(req,res)=>res.json({questions:await all('SELECT id,body,a,b,c,d,correct,explanation FROM questions WHERE exam_id=? ORDER BY id',[req.params.id])}));
app.delete('/api/admin/questions/:id',admin,async(req,res)=>{await run('DELETE FROM questions WHERE id=?',[req.params.id]);res.json({ok:true});});
app.post('/api/admin/students/import-csv',admin,async(req,res)=>{
  try{
    const rows=parse(String(req.body.csv||''),{columns:true,skip_empty_lines:true,trim:true,bom:true});
    if(rows.length>100) return res.status(400).json({error:'Maximum student capacity is 100.'});
    const current=await get("SELECT COUNT(*) count FROM users WHERE role='student'");
    let added=0; const errors=[]; let capacity=100-current.count;
    for(const r of rows){
      if(capacity<=0){errors.push('capacity limit reached');break;}
      const username=String(r.username||r.roll||'').trim(), name=String(r.name||'').trim(), password=String(r.password||'').trim();
      if(!username||!name||password.length<8){errors.push(username||'unknown');continue;}
      try{await run('INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,?)',[username,name,await bcrypt.hash(password,12),'student']);added++;capacity--;}catch(e){errors.push(username);}
    }
    res.json({added,errors,capacity});
  }catch(e){res.status(400).json({error:'Invalid CSV. Required columns: username,name,password.'});}
});
app.get('/api/admin/results/:examId',admin,async(req,res)=>{
  const rows=await all(`SELECT u.username,u.name,a.score,a.correct_count,a.wrong_count,a.skipped_count,a.submitted_at FROM attempts a JOIN users u ON u.id=a.user_id WHERE a.exam_id=? AND a.submitted_at IS NOT NULL ORDER BY a.score DESC,a.submitted_at ASC`,[req.params.examId]);
  res.json({results:rows.map((r,i)=>({...r,rank:i+1}))});
});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

init().then(()=>app.listen(PORT,()=>console.log(`Abhishek Singha Online Test running on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
