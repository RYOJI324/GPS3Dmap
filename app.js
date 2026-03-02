const map = new maplibregl.Map({
  container: 'map',
  style: 'https://api.openfreemap.org/styles/liberty',
  center: [139.767,35.681],
  zoom: 14,
  pitch: 0
});

let pins = [];
let autoInterval = null;

map.on('load', () => {
  map.addSource('route', {
    type: 'geojson',
    data: {
      type:'Feature',
      geometry:{ type:'LineString', coordinates:[] }
    }
  });

  map.addLayer({
    id:'route-line',
    type:'line',
    source:'route',
    paint:{
      'line-color':'#ffff00',
      'line-width':6
    }
  });
});

function updateRoute(){
  const coords = pins.map(p => [p.lng, p.lat]);
  map.getSource('route').setData({
    type:'Feature',
    geometry:{ type:'LineString', coordinates:coords }
  });
}

function addPin(lat,lng){
  const marker = new maplibregl.Marker({element:createPin()})
    .setLngLat([lng,lat])
    .addTo(map);

  pins.push({lat,lng,marker,time:new Date()});
  updateRoute();
}

function createPin(){
  const el = document.createElement('div');
  el.innerHTML = "📍";
  el.style.fontSize = "26px";
  return el;
}

document.getElementById('recordBtn').onclick = () => {
  navigator.geolocation.getCurrentPosition(pos=>{
    addPin(pos.coords.latitude,pos.coords.longitude);
  });
};

document.getElementById('autoBtn').onclick = () => {
  if(autoInterval){
    clearInterval(autoInterval);
    autoInterval=null;
    alert("自動記録停止");
  } else {
    autoInterval=setInterval(()=>{
      navigator.geolocation.getCurrentPosition(pos=>{
        addPin(pos.coords.latitude,pos.coords.longitude);
      });
    },180000);
    alert("自動記録開始（3分間隔）");
  }
};

document.getElementById('photoInput').addEventListener('change',function(e){
  for(let file of e.target.files){
    EXIF.getData(file,function(){
      const lat = EXIF.getTag(this,"GPSLatitude");
      const lng = EXIF.getTag(this,"GPSLongitude");
      if(lat && lng){
        const latNum = lat[0]+lat[1]/60+lat[2]/3600;
        const lngNum = lng[0]+lng[1]/60+lng[2]/3600;
        addPin(latNum,lngNum);
      }
    });
  }
});