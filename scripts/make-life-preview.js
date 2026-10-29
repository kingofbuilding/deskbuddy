'use strict';
// 将已生成的动画帧编码为 APNG 预览；不修改任何角色源图。
const fs=require('node:fs'),path=require('node:path');
const {Resvg}=require('@resvg/resvg-js');
const assets=path.join(__dirname,'..','src','renderer','assets');
const steps=[['idle',1400],['blink',145],['idle',220],['blink',145],['idle',1000],['wave',450,-2],['wave',450,2]];
for(let i=0;i<5;i++){steps.push(['walk_left',210,0,-3],['walk_right',210,0,0]);}
steps.push(['idle',1500]);
function chunks(png){let p=8,out=[];while(p<png.length){const n=png.readUInt32BE(p);out.push({type:png.toString('ascii',p+4,p+8),data:png.subarray(p+8,p+8+n)});p+=n+12;}return out;}
function chunk(type,data){const t=Buffer.from(type),input=Buffer.concat([t,data]);let crc=0xffffffff;for(const b of input){crc^=b;for(let k=0;k<8;k++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}const h=Buffer.alloc(4),c=Buffer.alloc(4);h.writeUInt32BE(data.length);c.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([h,t,data,c]);}
const rendered=steps.map(([name,delay,angle=0,y=0])=>{
 const source=fs.readFileSync(path.join(assets,'girl-'+name+'.png')).toString('base64');
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="290"><rect width="260" height="290" rx="22" fill="#edf4fa"/><g transform="translate(0 ${y}) rotate(${angle} 130 250)"><image href="data:image/png;base64,${source}" x="8" y="8" width="244" height="272" preserveAspectRatio="xMidYMid meet"/></g></svg>`;
 return {delay,chunks:chunks(new Resvg(svg).render().asPng())};
});
const signature=Buffer.from([137,80,78,71,13,10,26,10]),control=Buffer.alloc(8);control.writeUInt32BE(rendered.length,0);control.writeUInt32BE(0,4);
const output=[signature,chunk('IHDR',rendered[0].chunks.find(c=>c.type==='IHDR').data),chunk('acTL',control)];let sequence=0;
rendered.forEach((frame,i)=>{const fc=Buffer.alloc(26);fc.writeUInt32BE(sequence++,0);fc.writeUInt32BE(260,4);fc.writeUInt32BE(290,8);fc.writeUInt16BE(frame.delay,20);fc.writeUInt16BE(1000,22);fc[24]=0;fc[25]=0;output.push(chunk('fcTL',fc));const idat=Buffer.concat(frame.chunks.filter(c=>c.type==='IDAT').map(c=>c.data));if(i===0)output.push(chunk('IDAT',idat));else{const serial=Buffer.alloc(4);serial.writeUInt32BE(sequence++);output.push(chunk('fdAT',Buffer.concat([serial,idat])));}});
output.push(chunk('IEND',Buffer.alloc(0)));fs.writeFileSync(path.join(__dirname,'..','docs','previews','life-animation.png'),Buffer.concat(output));console.log('APNG: '+rendered.length+' frames, docs/previews/life-animation.png');
