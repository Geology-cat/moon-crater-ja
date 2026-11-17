import struct, sys, json
def read_dbf(path):
    with open(path,'rb') as f:
        hdr=f.read(32)
        n=struct.unpack('<I',hdr[4:8])[0]; hl=struct.unpack('<H',hdr[8:10])[0]; rl=struct.unpack('<H',hdr[10:12])[0]
        fields=[]
        while True:
            d=f.read(32)
            if d[0]==0x0D: break
            name=d[:11].split(b'\0')[0].decode(); fields.append((name,chr(d[11]),d[16]))
        f.seek(hl)
        out=[]
        for i in range(n):
            r=f.read(rl)
            if r[0:1]==b'*': continue
            pos=1; rec={}
            for name,t,l in fields:
                rec[name]=r[pos:pos+l].decode('utf-8','replace').strip(); pos+=l
            out.append(rec)
    return fields,out
if __name__=='__main__':
    fields,recs=read_dbf(sys.argv[1])
    print(fields); print(len(recs))
    for r in recs[:3]: print(r)
