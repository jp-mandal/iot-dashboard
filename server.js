const express = require('express');
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { Parser } = require('json2csv');
const webpush = require('web-push');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ===== THRESHOLDS =====
const TEMP_LIMIT = 30;
const CO_LIMIT = 50;
const METHANE_LIMIT = 1000;

// ===== USERS =====
const USERS = {
  admin: { password: "1234", role: "admin" },
  user: { password: "1234", role: "user" }
};

let currentRole = "";

// ===== VAPID =====
const PUBLIC_KEY = "BAV36BWFZHKSJhaSxWvPeFODkdGTG5kZjn6uOZQtM0wrvcvLy4WRnNVwIJRYtMrCVAWrmx_4uF5We8G-YmX9rmU";
const PRIVATE_KEY = "uOnrKBHB14vMBN7zPFqmi4XCQv4C2ZG2SGmzXHRcdvA";

webpush.setVapidDetails(
  "mailto:jpmandal123456@gmail.com",
  PUBLIC_KEY,
  PRIVATE_KEY
);

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

const Subscriber = mongoose.model("Subscriber", {
  endpoint:String,
  keys:Object
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

client.on('message', async (topic,msg)=>{
  try {
    let d = JSON.parse(msg.toString());
    d.time = new Date();

    let node = d.node;

    if(!buffer[node]) buffer[node]=[];
    buffer[node].push(d);

    buffer[node]=buffer[node].filter(x=>Date.now()-new Date(x.time)<60000);

    let arr = buffer[node];

    let avg = {
      node,
      temp: arr.reduce((s,x)=>s+x.temp,0)/arr.length,
      hum: arr.reduce((s,x)=>s+x.hum,0)/arr.length,
      co: arr.reduce((s,x)=>s+x.co,0)/arr.length,
      methane: arr.reduce((s,x)=>s+x.methane,0)/arr.length,
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
        temp: dArr.reduce((s,x)=>s+x.temp,0)/dArr.length,
        hum: dArr.reduce((s,x)=>s+x.hum,0)/dArr.length,
        co: dArr.reduce((s,x)=>s+x.co,0)/dArr.length,
        methane: dArr.reduce((s,x)=>s+x.methane,0)/dArr.length,
        date: today
      };

      await Daily.create(dailyAvg);
      dailyBuffer[node]=[];
    }

    // ===== ALERT =====
    if(Date.now()-lastAlertTime>300000){
      if(avg.temp>TEMP_LIMIT || avg.co>CO_LIMIT || avg.methane>METHANE_LIMIT){

        lastAlertTime=Date.now();

        const payload = JSON.stringify({
          title: "🚨 Alert",
          body: `${node} | Temp:${avg.temp}°C CO:${avg.co} CH4:${avg.methane}`
        });

        const subs = await Subscriber.find();
        subs.forEach(sub=>{
          webpush.sendNotification(sub,payload).catch(()=>{});
        });
      }
    }

  } catch(e){}
});

// ===== SUBSCRIBE =====
app.post('/subscribe-notification', async (req,res)=>{
  const sub=req.body;
  const exists=await Subscriber.findOne({endpoint:sub.endpoint});
  if(!exists) await Subscriber.create(sub);
  res.sendStatus(201);
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
  let rows={};

  data.forEach(d=>{
    let t=new Date(d.time).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});

    if(!rows[t]) rows[t]={Time:t};

    rows[t][`${d.node}_Temp`]=d.temp;
    rows[t][`${d.node}_Hum`]=d.hum;
    rows[t][`${d.node}_CO`]=d.co;
    rows[t][`${d.node}_Methane`]=d.methane;
  });

  const parser=new Parser();
  const csv=parser.parse(Object.values(rows));

  res.header('Content-Type','text/csv');
  res.attachment('iot_data.csv');
  res.send(csv);
});

// ===== UI =====
app.get('/',(req,res)=>{
res.send(`
<!DOCTYPE html>
<html>
<head>
<title>IoT Dashboard</title>
<style>
body{font-family:Arial;background:#0f172a;color:white;text-align:center;}
.container{display:flex;flex-wrap:wrap;justify-content:center;gap:20px;}
.card{background:#1e293b;padding:20px;border-radius:15px;width:250px;}
</style>
</head>
<body>

<h1>🌍 IoT Dashboard</h1>
<button onclick="enableNotifications()">🔔 Enable Alerts</button>

<div id="roleSelect">
<button onclick="selectRole('admin')">Admin</button>
<button onclick="selectRole('user')">User</button>
</div>

<div id="loginBox" style="display:none;">
<input id="u"><input id="p" type="password">
<button onclick="login()">Login</button>
</div>

<div id="userUI" style="display:none;">
<div class="container" id="cards"></div>
</div>

<div id="adminUI" style="display:none;">
<button onclick="download()">Download CSV</button>
<button onclick="reset()">Reset</button>
<table border="1"><tbody id="table"></tbody></table>
</div>

<script>
const ALL_NODES=["node1","node2","node3"];

function selectRole(r){roleSelect.style.display="none";loginBox.style.display="block";window.role=r;}

async function login(){
let res=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.value,password:p.value,role:role})});
let d=await res.json();
if(d.success){
loginBox.style.display="none";
if(role=="admin"){adminUI.style.display="block";loadAdmin();}
else{userUI.style.display="block";loadUser();}
}
}

async function loadUser(){
let res=await fetch('/api/data');let data=await res.json();
let html="";
ALL_NODES.forEach(n=>{
if(data[n]){
let d=data[n];
html+=\`<div class="card"><h3>\${n}</h3>
<p>Temp: \${d.temp}</p>
<p>Hum: \${d.hum}</p>
<p>CO: \${d.co}</p>
<p>CH4: \${d.methane}</p></div>\`;
}else{
html+=\`<div class="card"><h3>\${n}</h3>⚠️ Repair</div>\`;
}});
cards.innerHTML=html;
setTimeout(loadUser,2000);
}

async function loadAdmin(){
let res=await fetch('/api/data');let data=await res.json();
let html="";
ALL_NODES.forEach(n=>{
if(data[n]){
let d=data[n];
html+=\`<tr><td>\${n}</td><td>\${d.temp}</td><td>\${d.hum}</td><td>\${d.co}</td><td>\${d.methane}</td><td><button onclick="del('\${n}')">Clear</button></td></tr>\`;
}else{
html+=\`<tr><td>\${n}</td><td colspan="4">Repair</td></tr>\`;
}});
table.innerHTML=html;
setTimeout(loadAdmin,3000);
}

function reset(){fetch('/reset');}
function del(n){fetch('/delete/'+n);}
function download(){window.location='/download';}
</script>

</body>
</html>
`);
});

app.listen(PORT,()=>console.log("🚀 Running"));
