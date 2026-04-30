const express = require('express');
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

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
.then(()=>console.log("✅ MongoDB Connected"));

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

// ===== DATA PROCESS =====
client.on('message', async (topic,msg)=>{
  try{
    let d = JSON.parse(msg.toString());
    d.time = new Date();

    let node = d.node;

    // ===== 1 MIN BUFFER =====
    if(!buffer[node]) buffer[node]=[];
    buffer[node].push(d);

    buffer[node]=buffer[node].filter(x=>Date.now()-new Date(x.time)<60000);

    let arr = buffer[node];

    let avg = {
      node,
      temp: Number((arr.reduce((s,x)=>s+x.temp,0)/arr.length).toFixed(2)),
      hum: Number((arr.reduce((s,x)=>s+x.hum,0)/arr.length).toFixed(2)),
      co: Number((arr.reduce((s,x)=>s+x.co,0)/arr.length).toFixed(2)),
      methane: Number((arr.reduce((s,x)=>s+x.methane,0)/arr.length).toFixed(2)),
      time:new Date()
    };

    latestData[node]=avg;
    await Data.create(avg);

    // ===== DAILY BUFFER =====
    let today = new Date().toISOString().slice(0,10);

    if(!dailyBuffer[node]) dailyBuffer[node]=[];
    dailyBuffer[node].push(avg);

    if(dailyBuffer[node].length >= 1440){

      let dArr = dailyBuffer[node];

      let dailyAvg = {
        node,
        temp: Number((dArr.reduce((s,x)=>s+x.temp,0)/dArr.length).toFixed(2)),
        hum: Number((dArr.reduce((s,x)=>s+x.hum,0)/dArr.length).toFixed(2)),
        co: Number((dArr.reduce((s,x)=>s+x.co,0)/dArr.length).toFixed(2)),
        methane: Number((dArr.reduce((s,x)=>s+x.methane,0)/dArr.length).toFixed(2)),
        date: today
      };

      await Daily.create(dailyAvg);
      dailyBuffer[node] = [];
    }

    // ===== ALERT =====
    if(Date.now()-lastAlertTime > 300000){
      if(
        avg.temp >= TEMP_LIMIT ||
        avg.co >= CO_LIMIT ||
        avg.methane >= METHANE_LIMIT
      ){
        lastAlertTime = Date.now();
        console.log("🚨 ALERT:", avg);
      }
    }

  }catch(e){}
});

// ===== LOGIN =====
app.post('/login',(req,res)=>{
  const {username,password,role}=req.body;

  if(USERS[username] && USERS[username].password===password && USERS[username].role===role){
    currentRole=role;
    res.json({success:true});
  } else res.json({success:false});
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

// ===== CSV (MIN + DAILY IN SAME FILE) =====
app.get('/download',async(req,res)=>{
  if(currentRole!=="admin") return res.send("Unauthorized");

  let data=await Data.find().sort({time:1});
  let daily=await Daily.find();

  let rows={};

  // ===== MINUTE DATA =====
  data.forEach(d=>{
    let t=new Date(d.time).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});

    if(!rows[t]) rows[t]={Type:"Minute", Time:t};

    rows[t][`${d.node}_Temp`]=d.temp;
    rows[t][`${d.node}_Hum`]=d.hum;
    rows[t][`${d.node}_CO`]=d.co;
    rows[t][`${d.node}_Methane`]=d.methane;
  });

  // ===== DAILY DATA =====
  daily.forEach(d=>{
    let key = "DAY_"+d.date;

    if(!rows[key]) rows[key]={Type:"Daily Avg", Time:d.date};

    rows[key][`${d.node}_Temp`]=d.temp;
    rows[key][`${d.node}_Hum`]=d.hum;
    rows[key][`${d.node}_CO`]=d.co;
    rows[key][`${d.node}_Methane`]=d.methane;
  });

  const parser=new Parser();
  const csv=parser.parse(Object.values(rows));

  res.header('Content-Type','text/csv');
  res.attachment('iot_data.csv');
  res.send(csv);
});

// ===== UI (UNCHANGED) =====
app.get('/',(req,res)=>{
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

table {
  margin:auto;
  width:80%;
  border-collapse:collapse;
}

th, td {
  border:1px solid white;
  padding:10px;
}
</style>
</head>

<body>

<h1>🌍 IoT Dashboard</h1>

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
  <h2>User Dashboard</h2>
  <div class="container" id="cards"></div>
</div>

<div id="adminUI" style="display:none;">
  <h2>Admin Dashboard</h2>
  <button onclick="download()">Download CSV</button>
  <button onclick="reset()">Reset DB</button>

  <table>
    <thead>
      <tr>
        <th>Node</th>
        <th>Temp</th>
        <th>Hum</th>
        <th>CO</th>
        <th>CH4</th>
        <th>Time</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="table"></tbody>
  </table>
</div>

<script>

const ALL_NODES = ["node1","node2","node3"];

function getWeather(t){
  if(t>35) return "☀️";
  if(t>25) return "⛅";
  if(t>15) return "☁️";
  return "🌧";
}

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
  }
}

async function loadUser(){
  let res=await fetch('/api/data');
  let data=await res.json();

  let html="";

  ALL_NODES.forEach(n=>{
    if(data[n]){
      let d=data[n];
      let deg=(d.temp/50)*360;

      html+=\`
      <div class="card">
        <h3>\${n}</h3>
        <div class="weather">\${getWeather(d.temp)}</div>
        <div class="circle" style="--deg:\${deg}deg">
          <div class="inner">\${d.temp}°C</div>
        </div>
        <p>💧 \${d.hum}%</p>
        <p>🟡 CO: \${d.co}</p>
        <p>🟢 CH4: \${d.methane}</p>
      </div>\`;
    } else {
      html+=\`
      <div class="card">
        <h3>\${n}</h3>
        <div style="color:orange;">⚠️ Node under repair</div>
      </div>\`;
    }
  });

  cards.innerHTML=html;
  setTimeout(loadUser,2000);
}

async function loadAdmin(){
  let res=await fetch('/api/data');
  let data=await res.json();

  let html="";

  ALL_NODES.forEach(n=>{
    if(data[n]){
      let d=data[n];

      html+=\`
      <tr>
        <td>\${n}</td>
        <td>\${d.temp}</td>
        <td>\${d.hum}</td>
        <td>\${d.co}</td>
        <td>\${d.methane}</td>
        <td>\${new Date(d.time).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</td>
        <td><button onclick="del('\${n}')">Clear</button></td>
      </tr>\`;
    } else {
      html+=\`
      <tr>
        <td>\${n}</td>
        <td colspan="5">⚠️ Repair</td>
      </tr>\`;
    }
  });

  table.innerHTML=html;
  setTimeout(loadAdmin,3000);
}

function reset(){ fetch('/reset'); }
function del(n){ fetch('/delete/'+n); }
function download(){ window.location='/download'; }

</script>

</body>
</html>

`);
});

app.listen(PORT,()=>console.log("🚀 Running"));
