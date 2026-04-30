const express = require('express');
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');
const webpush = require('web-push');

const app = express();
app.use(bodyParser.json());

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
mongoose.connect(process.env.MONGO_URL);

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

client.on('connect',()=>client.subscribe("pollution/#"));

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

      await Daily.create({
        node,
        temp:(dArr.reduce((s,x)=>s+x.temp,0)/dArr.length).toFixed(2),
        hum:(dArr.reduce((s,x)=>s+x.hum,0)/dArr.length).toFixed(2),
        co:(dArr.reduce((s,x)=>s+x.co,0)/dArr.length).toFixed(2),
        methane:(dArr.reduce((s,x)=>s+x.methane,0)/dArr.length).toFixed(2),
        date:today
      });

      dailyBuffer[node]=[];
    }

    // ===== ALERT =====
    if(Date.now()-lastAlertTime>300000){
      if(avg.temp>=TEMP_LIMIT || avg.co>=CO_LIMIT || avg.methane>=METHANE_LIMIT){

        lastAlertTime = Date.now();

        const payload = JSON.stringify({
          title: "🚨 Pollution Alert",
          body: `${node} Temp:${avg.temp}°C CO:${avg.co} CH4:${avg.methane}`
        });

        subscribers.forEach(sub=>{
          webpush.sendNotification(sub,payload).catch(()=>{});
        });
      }
    }

  }catch(e){}
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
  } else res.json({success:false});
});

// ===== API =====
app.get('/api/data',(req,res)=>{
  let now=Date.now();
  let out={};

  for(let n of ["node1","node2","node3"]){
    if(latestData[n] && (now-new Date(latestData[n].time)<120000)){
      out[n]=latestData[n];
    } else {
      out[n]={repair:true,node:n};
    }
  }

  res.json(out);
});

// ===== CSV =====
app.get('/download',async(req,res)=>{
  if(currentRole!=="admin") return res.send("Unauthorized");

  let data=await Data.find();
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
app.get('/', (req, res) => {
res.send(`

<!DOCTYPE html>
<html>
<head>
<title>IoT Dashboard</title>

<style>
body { font-family: Arial; background:#0f172a; color:white; text-align:center; }
button { padding:10px; margin:10px; background:#22c55e; border:none; color:white; cursor:pointer; }

.container { display:flex; flex-wrap:wrap; justify-content:center; gap:20px; }

.card {
  background:#1e293b;
  padding:20px;
  border-radius:15px;
  width:250px;
}

.circle {
  width:120px;
  height:120px;
  border-radius:50%;
  background:conic-gradient(#22c55e 0deg, #22c55e var(--deg), #334155 var(--deg));
  display:flex;
  align-items:center;
  justify-content:center;
  margin:auto;
}

.inner {
  width:90px;
  height:90px;
  border-radius:50%;
  background:#0f172a;
  display:flex;
  align-items:center;
  justify-content:center;
}

.weather { font-size:40px; }
</style>
</head>

<body>

<h1>🌍 IoT Dashboard</h1>
<button onclick="enableAlerts()">🔔 Enable Alerts</button>

<div id="roleSelect">
  <button onclick="selectRole('admin')">👑 Admin</button>
  <button onclick="selectRole('user')">👤 User</button>
</div>

<div id="loginBox" style="display:none;">
  <h2 id="roleTitle"></h2>
  <input id="u" placeholder="Username"><br>
  <input id="p" type="password" placeholder="Password"><br>
  <button onclick="login()">Login</button>
</div>

<div id="userUI" style="display:none;">
  <div class="container" id="cards"></div>
</div>

<div id="adminUI" style="display:none;">
  <button onclick="download()">Download CSV</button>
  <button onclick="reset()">Reset DB</button>
  <table border="1" style="margin:auto;">
    <tbody id="table"></tbody>
  </table>
</div>

<script>

let selectedRole="";

function selectRole(role){
  selectedRole=role;
  roleSelect.style.display="none";
  loginBox.style.display="block";
  roleTitle.innerText=role.toUpperCase()+" LOGIN";
}

async function login(){
  let res=await fetch('/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u.value,password:p.value,role:selectedRole})
  });

  let d=await res.json();

  if(d.success){
    loginBox.style.display='none';
    if(selectedRole==="admin"){
      adminUI.style.display="block";
      loadAdmin();
    } else {
      userUI.style.display="block";
      loadUser();
    }
  } else alert("Wrong credentials");
}

function getWeather(t){
  if(t>35) return "☀️";
  if(t>25) return "⛅";
  if(t>15) return "☁️";
  return "🌧";
}

async function loadUser(){
  let res=await fetch('/api/data');
  let data=await res.json();

  let html="";

  for(let n in data){
    let d=data[n];

    if(d.repair){
      html+=\`
      <div class="card">
        <h3>\${n}</h3>
        <p>🛠 Node in repair</p>
      </div>\`;
      continue;
    }

    let deg=(d.temp/50)*360;

    html+=\`
    <div class="card">
      <h3>\${d.node}</h3>
      <div class="weather">\${getWeather(d.temp)}</div>
      <div class="circle" style="--deg:\${deg}deg">
        <div class="inner">\${d.temp.toFixed(2)}°C</div>
      </div>
      <p>💧 \${d.hum.toFixed(2)}%</p>
      <p>🧪 CO: \${d.co.toFixed(2)}</p>
      <p>🔥 CH4: \${d.methane.toFixed(2)}</p>
    </div>\`;
  }

  cards.innerHTML=html;
  setTimeout(loadUser,2000);
}

async function loadAdmin(){
  let res=await fetch('/api/data');
  let data=await res.json();

  let html="";
  for(let n in data){
    let d=data[n];

    if(d.repair){
      html+=\`<tr><td>\${n}</td><td colspan="4">Repair</td></tr>\`;
      continue;
    }

    html+=\`
    <tr>
      <td>\${d.node}</td>
      <td>\${d.temp.toFixed(2)}</td>
      <td>\${d.hum.toFixed(2)}</td>
      <td>\${d.co.toFixed(2)}</td>
      <td>\${d.methane.toFixed(2)}</td>
    </tr>\`;
  }

  table.innerHTML=html;
  setTimeout(loadAdmin,3000);
}

function download(){ window.location='/download'; }

// ===== ALERT =====
async function enableAlerts(){
  const permission = await Notification.requestPermission();
  if(permission !== 'granted') return alert("Permission denied");

  const reg = await navigator.serviceWorker.register('/sw.js');

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly:true,
    applicationServerKey: urlBase64ToUint8Array("${PUBLIC_KEY}")
  });

  await fetch('/subscribe',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(sub)
  });

  alert("Alerts Enabled!");
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

</script>

</body>
</html>

`);
});

// ===== START =====
app.listen(PORT, () => console.log("🚀 Running"));
