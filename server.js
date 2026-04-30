const express = require('express');
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');
const webpush = require('web-push');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ===== PUSH KEYS =====
const PUBLIC_KEY = "BAV36BWFZHKSJhaSxWvPeFODkdGTG5kZjn6uOZQtM0wrvcvLy4WRnNVwIJRYtMrCVAWrmx_4uF5We8G-YmX9rmU";
const PRIVATE_KEY = "uOnrKBHB14vMBN7zPFqmi4XCQv4C2ZG2SGmzXHRcdvA";

webpush.setVapidDetails(
  'mailto:jpmandal123456@gmail.com',
  PUBLIC_KEY,
  PRIVATE_KEY
);

let subscribers = [];

// ===== THRESHOLDS =====
const TEMP_LIMIT = 30;
const CO_LIMIT = 30;
const METHANE_LIMIT = 500;

// ===== USERS =====
const USERS = {
  admin: { password: "1234", role: "admin" },
  user: { password: "1234", role: "user" }
};

let currentRole = "";

// ===== MONGO =====
mongoose.connect(process.env.MONGO_URL)
.then(()=>console.log("✅ MongoDB Connected"))
.catch(err=>console.log(err));

// ===== MODELS =====
const Data = mongoose.model("Data", {
  node:String,
  temp:Number,
  hum:Number,
  co:Number,
  methane:Number,
  time:{type:Date,default:Date.now}
});

const Daily = mongoose.model("Daily", {
  node:String,
  temp:Number,
  hum:Number,
  co:Number,
  methane:Number,
  date:String
});

// ===== MEMORY =====
let latestData = {};
let buffer = {};
let dailyBuffer = {};
let lastAlertTime = 0;

// ===== MQTT =====
const client = mqtt.connect('mqtts://7564b99907f74747bac93aa42ec8f77b.s1.eu.hivemq.cloud',{
  username:'climate',
  password:'Climate@2'
});

client.on('connect',()=>{
  console.log("✅ MQTT Connected");
  client.subscribe("pollution/#");
});

// ===== MESSAGE =====
client.on('message', async (topic,msg)=>{
  try{
    let d = JSON.parse(msg.toString());
    d.time = new Date();
    let node = d.node;

    // ===== 1 MIN AVG =====
    if(!buffer[node]) buffer[node]=[];
    buffer[node].push(d);

    buffer[node]=buffer[node].filter(x=>Date.now()-new Date(x.time)<60000);

    let arr = buffer[node];

    let avg = {
      node,
      temp:Number((arr.reduce((s,x)=>s+x.temp,0)/arr.length).toFixed(2)),
      hum:Number((arr.reduce((s,x)=>s+x.hum,0)/arr.length).toFixed(2)),
      co:Number((arr.reduce((s,x)=>s+x.co,0)/arr.length).toFixed(2)),
      methane:Number((arr.reduce((s,x)=>s+x.methane,0)/arr.length).toFixed(2)),
      time:new Date()
    };

    latestData[node]=avg;
    await Data.create(avg);

    // ===== DAILY AVG =====
    let today = new Date().toISOString().slice(0,10);

    if(!dailyBuffer[node]) dailyBuffer[node]=[];
    dailyBuffer[node].push(avg);

    if(dailyBuffer[node].length >= 1440){
      let dArr = dailyBuffer[node];

      let dailyAvg = {
        node,
        temp:Number((dArr.reduce((s,x)=>s+x.temp,0)/dArr.length).toFixed(2)),
        hum:Number((dArr.reduce((s,x)=>s+x.hum,0)/dArr.length).toFixed(2)),
        co:Number((dArr.reduce((s,x)=>s+x.co,0)/dArr.length).toFixed(2)),
        methane:Number((dArr.reduce((s,x)=>s+x.methane,0)/dArr.length).toFixed(2)),
        date:today
      };

      await Daily.create(dailyAvg);
      dailyBuffer[node]=[];
    }

    // ===== ALERT =====
    if(Date.now()-lastAlertTime > 300000){
      if(avg.temp>=TEMP_LIMIT || avg.co>=CO_LIMIT || avg.methane>=METHANE_LIMIT){

        lastAlertTime = Date.now();

        const payload = JSON.stringify({
          title: "🚨 Pollution Alert",
          body: `${node} → Temp:${avg.temp}°C CO:${avg.co} CH4:${avg.methane}`
        });

        subscribers.forEach(sub=>{
          webpush.sendNotification(sub,payload).catch(()=>{});
        });
      }
    }

  }catch(e){
    console.log(e.message);
  }
});

// ===== SUBSCRIBE =====
app.post('/subscribe',(req,res)=>{
  subscribers.push(req.body);
  res.sendStatus(201);
});

// ===== LOGIN =====
app.post('/login',(req,res)=>{
  const {username,password,role}=req.body;

  if(USERS[username] &&
     USERS[username].password===password &&
     USERS[username].role===role){
    currentRole=role;
    res.json({success:true});
  } else {
    res.json({success:false});
  }
});

// ===== API =====
app.get('/api/data',(req,res)=>{
  let now=Date.now();
  let out={};

  for(let n in latestData){
    if(now-new Date(latestData[n].time)<120000){
      out[n]=latestData[n];
    }
  }

  res.json(out);
});

// ===== ADMIN =====
app.get('/reset',async(req,res)=>{
  if(currentRole!=="admin") return res.send("Unauthorized");
  await Data.deleteMany({});
  await Daily.deleteMany({});
  latestData={};
  res.send("Cleared");
});

app.get('/delete/:node',async(req,res)=>{
  if(currentRole!=="admin") return res.send("Unauthorized");
  await Data.deleteMany({node:req.params.node});
  delete latestData[req.params.node];
  res.send("Deleted");
});

// ===== CSV =====
app.get('/download',async(req,res)=>{
  if(currentRole!=="admin") return res.send("Unauthorized");

  let data=await Data.find().sort({time:1});
  let daily=await Daily.find();

  let rows={};

  data.forEach(d=>{
    let t=new Date(d.time).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});
    if(!rows[t]) rows[t]={Type:"Minute",Time:t};

    rows[t][`${d.node}_Temp`]=d.temp;
    rows[t][`${d.node}_Hum`]=d.hum;
    rows[t][`${d.node}_CO`]=d.co;
    rows[t][`${d.node}_Methane`]=d.methane;
  });

  daily.forEach(d=>{
    let key="DAY_"+d.date;
    if(!rows[key]) rows[key]={Type:"Daily Avg",Time:d.date};

    rows[key][`${d.node}_Temp`]=d.temp;
    rows[key][`${d.node}_Hum`]=d.hum;
    rows[key][`${d.node}_CO`]=d.co;
    rows[key][`${d.node}_Methane`]=d.methane;
  });

  const parser=new Parser();
  res.attachment("iot.csv");
  res.send(parser.parse(Object.values(rows)));
});

// ===== UI =====
app.get('/',(req,res)=>{
res.send(`<!DOCTYPE html>
<html>
<head>
<title>IoT Dashboard</title>
<link rel="manifest" href="/manifest.json">
<style>
body { font-family: Arial; background:#0f172a; color:white; text-align:center; }
button { padding:10px; margin:10px; background:#22c55e; border:none; color:white; cursor:pointer; }
.container { display:flex; flex-wrap:wrap; justify-content:center; gap:20px; }
.card { background:#1e293b; padding:20px; border-radius:15px; width:250px; }
.circle { width:120px;height:120px;border-radius:50%;
background:conic-gradient(#22c55e 0deg,#22c55e var(--deg),#334155 var(--deg));
display:flex;align-items:center;justify-content:center;margin:auto;}
.inner { width:90px;height:90px;border-radius:50%;background:#0f172a;
display:flex;align-items:center;justify-content:center;}
.weather { font-size:40px; }
</style>
</head>

<body>

<h1>🌍 IoT Dashboard</h1>
<button onclick="enableNotifications()">🔔 Enable Alerts</button>

<div id="roleSelect">
<button onclick="selectRole('admin')">👑 Admin</button>
<button onclick="selectRole('user')">👤 User</button>
</div>

<div id="loginBox" style="display:none;">
<h2 id="roleTitle"></h2>
<input id="u"><br>
<input id="p" type="password"><br>
<button onclick="login()">Login</button>
</div>

<div id="userUI" style="display:none;">
<div class="container" id="cards"></div>
</div>

<div id="adminUI" style="display:none;">
<button onclick="download()">Download CSV</button>
<button onclick="reset()">Reset DB</button>
<table id="table"></table>
</div>

<script>

const PUBLIC_KEY = "${PUBLIC_KEY}";
let selectedRole="";

async function enableNotifications(){
const reg=await navigator.serviceWorker.register('/sw.js');
const sub=await reg.pushManager.subscribe({
userVisibleOnly:true,
applicationServerKey:urlBase64ToUint8Array(PUBLIC_KEY)
});
await fetch('/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
alert("Enabled");
}

function urlBase64ToUint8Array(base64String){
const padding='='.repeat((4-base64String.length%4)%4);
const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
const raw=window.atob(base64);
return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

function selectRole(role){
selectedRole=role;
document.getElementById("roleSelect").style.display="none";
document.getElementById("loginBox").style.display="block";
document.getElementById("roleTitle").innerText=role.toUpperCase()+" LOGIN";
}

async function login(){
let res=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({username:u.value,password:p.value,role:selectedRole})});
let d=await res.json();

if(d.success){
document.getElementById("loginBox").style.display='none';
if(selectedRole==="admin"){document.getElementById("adminUI").style.display="block";loadAdmin();}
else {document.getElementById("userUI").style.display="block";loadUser();}
}else alert("Wrong");
}

function getWeather(t){
if(t>35) return "☀️";
if(t>25) return "⛅";
if(t>15) return "☁️";
return "🌧";
}

async function loadUser(){
let r=await fetch('/api/data');
let d=await r.json();
let html="";

["node1","node2","node3"].forEach(n=>{
if(d[n]){
let deg=(d[n].temp/50)*360;
html+=\`<div class="card"><h3>\${n}</h3>
<div class="weather">\${getWeather(d[n].temp)}</div>
<div class="circle" style="--deg:\${deg}deg"><div class="inner">\${d[n].temp}°C</div></div>
<p>💧 \${d[n].hum}%</p>
<p>🟡 CO: \${d[n].co}</p>
<p>🟢 CH4: \${d[n].methane}</p></div>\`;
}else html+=\`<div class="card"><h3>\${n}</h3>⚠️ Repair</div>\`;
});

cards.innerHTML=html;
setTimeout(loadUser,2000);
}

async function loadAdmin(){
let r=await fetch('/api/data');
let d=await r.json();
let html="";

["node1","node2","node3"].forEach(n=>{
if(d[n]){
let x=d[n];
html+=\`<tr><td>\${n}</td><td>\${x.temp}</td><td>\${x.hum}</td><td>\${x.co}</td><td>\${x.methane}</td>
<td>\${new Date(x.time).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</td>
<td><button onclick="del('\${n}')">Clear</button></td></tr>\`;
}else html+=\`<tr><td>\${n}</td><td colspan="5">Repair</td></tr>\`;
});

document.getElementById("table").innerHTML=html;
setTimeout(loadAdmin,3000);
}

function reset(){fetch('/reset');}
function del(n){fetch('/delete/'+n);}
function download(){window.location='/download';}

</script>
</body>
</html>`);
});

app.listen(PORT,()=>console.log("🚀 Running"));
