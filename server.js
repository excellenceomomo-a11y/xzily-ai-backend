const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fetch = require("node-fetch");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("MongoDB Connected"));

const User = mongoose.model("User",{username:String,password:String});
const Chat = mongoose.model("Chat",{userId:String,title:String,messages:Array});

const upload = multer({ dest: "uploads/" });

function auth(req,res,next){
  const token=req.headers.authorization;
  if(!token) return res.status(401).send("No token");
  try{
    req.user=jwt.verify(token,process.env.JWT_SECRET);
    next();
  }catch{res.status(401).send("Invalid token")}
}

/* AUTH */
app.post("/register", async(req,res)=>{
  const hashed=await bcrypt.hash(req.body.password,10);
  await new User({username:req.body.username,password:hashed}).save();
  res.json({msg:"created"});
});

app.post("/login", async(req,res)=>{
  const user=await User.findOne({username:req.body.username});
  if(!user) return res.send("No user");

  const valid=await bcrypt.compare(req.body.password,user.password);
  if(!valid) return res.send("Wrong password");

  const token=jwt.sign({id:user._id},process.env.JWT_SECRET);
  res.json({token});
});

/* CHAT */
app.post("/chat", auth, async(req,res)=>{
  const {message,chatId}=req.body;
  let chat=await Chat.findOne({_id:chatId,userId:req.user.id});

  if(!chat) chat=new Chat({userId:req.user.id,messages:[]});

  chat.messages.push({role:"user",content:message});

  const aiRes=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:"gpt-4o-mini",
      messages:chat.messages
    })
  });

  const data=await aiRes.json();
  const reply=data.choices[0].message.content;

  chat.messages.push({role:"assistant",content:reply});
  await chat.save();

  res.json({reply,chatId:chat._id});
});

/* GET CHATS */
app.get("/chats", auth, async(req,res)=>{
  const chats=await Chat.find({userId:req.user.id});
  res.json(chats);
});

/* FILE */
app.post("/upload", auth, upload.single("file"), async(req,res)=>{
  let text="";
  if(req.file.mimetype==="application/pdf"){
    const data=await pdfParse(fs.readFileSync(req.file.path));
    text=data.text;
  } else if(req.file.mimetype.includes("word")){
    const data=await mammoth.extractRawText({path:req.file.path});
    text=data.value;
  } else {
    text=fs.readFileSync(req.file.path,"utf8");
  }

  const aiRes=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:"gpt-4o-mini",
      messages:[{role:"user",content:"Explain:\n"+text.slice(0,5000)}]
    })
  });

  const data=await aiRes.json();
  fs.unlinkSync(req.file.path);

  res.json({reply:data.choices[0].message.content});
});

/* IMAGE */
app.post("/upload-image", auth, upload.single("image"), async(req,res)=>{
  const img=fs.readFileSync(req.file.path).toString("base64");

  const aiRes=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:"gpt-4o-mini",
      messages:[{
        role:"user",
        content:[
          {type:"text",text:"Explain this image"},
          {type:"image_url",image_url:{url:`data:image/jpeg;base64,${img}`}}
        ]
      }]
    })
  });

  const data=await aiRes.json();
  fs.unlinkSync(req.file.path);

  res.json({reply:data.choices[0].message.content});
});

app.listen(3000, ()=>console.log("Server running 🚀"));
