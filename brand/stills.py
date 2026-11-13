import os, subprocess, json, shutil
from PIL import Image
B='/Users/miguelsolorio/Developer/desertscape/brand'
# (source, slug, title, note, logo place, crop (x0, y0, w) as fractions or None)
PICK=[
 ('m01','sun-behind-the-peak','The sun behind the peak','Golden hour','br',None,'Wander until the stars come out'),
 ('n03','first-light','First light','Sunrise on the ripples','tl',None,'Follow the light'),
 ('m11','long-shadows','Long shadows','Late afternoon','tl',None,'Every dune is a direction'),
 ('n05','after-sunset','After sunset','Dusk','tl',None,'Nowhere to be. Everywhere to go.'),
 ('m16','high-sun','Over the dunes','The sun above the summit','tl',None,'A quiet place to get lost'),
 ('m18','two-suns','The far range','Golden hour','tl',None,'Walk, glide, fly'),
 ('n07','at-the-foot','At the foot of it','Golden hour, from low down','tr',None,'Find your own way across'),
 ('m13','small-figure','A small figure','Dusk','tl',None,'The horizon is the only path'),
 ('n02','last-light','Last light','Sunset','tl',None,'Lose the trail. Keep the stars.'),
 ('m08','the-climb','The climb ahead','Afternoon','tl',None,'A small figure in a very large desert'),
 ('n09','dawn-ridge','Dawn on the ridge','Sunrise','tr',None,'Go where the wind goes'),
 ('n11','between-dunes','Between the dunes','Golden hour','bl',None,'Somewhere past the next dune'),
 ('n12','carpet','Towards the mountain','On the carpet at golden hour','tl',None,'Sand, sky and all the time you need'),
 ('n15','board','Riding out','On the board, late afternoon','tl',(0.2,0.2,0.8),'Climb it because it is there'),
 ('m04','morning','Morning','Teal sky and a snow cap','tr',None,'Take the long way'),
 ('m14','midday','Open sand','Morning light','bl',None,'Let the mountains lead you'),
 ('n06','the-giant','The giant','Morning','tl',None,'Where the map ends, begin'),
 ('m09','river-below','The river below','Golden hour','tr',None,'The far peak is closer than it looks'),
 ('m15','night-ripples','Night ripples','Moonlight','tl',None,'A desert to breathe in'),
 ('n04','lanterns','Lanterns on the summit','Night','tl',None,'Named for a star. Made for wandering.'),
]
for d in ('stills','shots/stills'):
    shutil.rmtree(f'{B}/{d}',ignore_errors=True); os.makedirs(f'{B}/{d}')
meta=[]
for i,(src,slug,title,note,place,crop,tagline) in enumerate(PICK,1):
    im=Image.open(f'stills2/{src}.png').convert('RGB'); W,H=im.size
    if crop:
        x0,y0,w=crop; cw=int(W*w); ch=int(cw*630/1200)
        im=im.crop((int(W*x0),int(H*y0),int(W*x0)+cw,int(H*y0)+ch))
    clean=f'{B}/shots/stills/{i:02d}-{slug}.jpg'; im.save(clean,quality=90)
    out=f'{B}/stills/{i:02d}-{slug}'
    subprocess.run(['python3',f'{B}/compose.py',clean,'--place',place,'--size','96','--tagline',tagline,'--out',out],check=True,capture_output=True)
    Image.open(out+'.png').convert('RGB').save(out+'.jpg',quality=88); os.remove(out+'.png')
    meta.append({'n':i,'file':f'{i:02d}-{slug}','title':title,'note':note,'tagline':tagline,'px':im.size[0]})
json.dump(meta,open('stills.json','w'))
print(len(meta), sum(os.path.getsize(f'{B}/stills/'+f) for f in os.listdir(f'{B}/stills'))//1024,'KB')
# contact sheet
s=Image.new('RGB',(4*450,5*236))
for m in meta:
    k=m['n']-1; s.paste(Image.open(f"{B}/stills/{m['file']}.jpg").resize((450,236)),((k%4)*450,(k//4)*236))
s.save('r/stills.jpg',quality=82)
