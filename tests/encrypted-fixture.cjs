// Minimal Standard Security revision-2 fixture. This obsolete cipher is only test data,
// never used to protect or export user documents. The reader itself delegates to PDF.js.
const crypto = require('node:crypto');
const md5 = data => crypto.createHash('md5').update(data).digest();
const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
function padded(value) { return Buffer.concat([Buffer.from(value, 'latin1'), padding]).subarray(0,32); }
function rc4(key, bytes) {
  const s = Array.from({length:256}, (_,i)=>i), output=Buffer.alloc(bytes.length);
  let j=0;
  for(let i=0;i<256;i++) { j=(j+s[i]+key[i%key.length])&255; [s[i],s[j]]=[s[j],s[i]]; }
  let i=0; j=0;
  for(let n=0;n<bytes.length;n++) { i=(i+1)&255; j=(j+s[i])&255; [s[i],s[j]]=[s[j],s[i]]; output[n]=bytes[n]^s[(s[i]+s[j])&255]; }
  return output;
}
module.exports = function encryptedFixture() {
  const id=md5(Buffer.from('lyra-password-test'));
  const owner=rc4(md5(padded('owner-test')).subarray(0,5),padded('lyra-test'));
  const permissions=Buffer.alloc(4); permissions.writeInt32LE(-4);
  const key=md5(Buffer.concat([padded('lyra-test'),owner,permissions,id])).subarray(0,5);
  const user=rc4(key,padding);
  const streamKey=md5(Buffer.concat([key,Buffer.from([5,0,0,0,0])])).subarray(0,10);
  const stream=rc4(streamKey,Buffer.from('BT /F1 24 Tf 48 720 Td (Encrypted PDF test) Tj ET'));
  const objects=[
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`)
  ];
  let data=Buffer.from('%PDF-1.7\n'), offsets=[0];
  objects.forEach((object,i)=>{ offsets.push(data.length); data=Buffer.concat([data,Buffer.from(`${i+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]); });
  const xref=data.length;
  let tail=`xref\n0 7\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1)) tail+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  tail+=`trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([data,Buffer.from(tail)]);
};
