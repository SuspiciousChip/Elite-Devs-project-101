(function(){
  "use strict";

  // Consume the desktopCapture streamId (if any) as the very first thing
  // this page does. chooseDesktopMedia() scopes its streamId to whichever
  // tab background.js passed as targetTab — which is THIS tab — so the
  // streamId can only ever arrive here via a runtime message sent after
  // background.js hears we're ready, never via the URL. Registering the
  // listener and sending "ready" synchronously (before theme/data loading
  // below) also means the streamId isn't even requested until we're able
  // to consume it immediately, sidestepping its few-seconds expiry.
  let __pendingAutoCapture = null;
  (function kickOffAutoCaptureEarly(){
    try{
      const params = new URLSearchParams(location.search);
      if(params.get('autocapture')==='1'){
        // Strip the params immediately so a refresh of this tab never
        // re-triggers a capture.
        history.replaceState(null,'',location.pathname);
        __pendingAutoCapture = new Promise((resolve)=>{
          function onStreamMessage(message){
            if(!message || message.type !== 'thinksync-stream-id') return;
            chrome.runtime.onMessage.removeListener(onStreamMessage);
            if(message.streamId){
              resolve(captureScreenFromStreamId(message.streamId));
            }else{
              resolve(null);
            }
          }
          chrome.runtime.onMessage.addListener(onStreamMessage);
          chrome.runtime.sendMessage({type:'thinksync-ready-for-capture'});
        });
      }
    }catch(_error){ __pendingAutoCapture = null; /* fall through to a normal app load */ }
  })();

  const APP_CONFIG = Object.freeze({
    appName: 'ThinkSync',
    demoMode: true,
    seedVersion: 2,
    enableNetworkAI: false,
    simulatedAnalysisDelay: 900
  });

  const AI_RUNTIME = { endpoint: null };
  const AI_SYSTEM_PROMPT = `You are ThinkSync Recall, a grounded assistant inside a personal memory application.

You receive a JSON array named SAVED_MEMORIES. Each memory may contain id, type, title, text, transcript, image captions, metadata, and checklist items with completion state.

Rules:
1. Answer using only facts explicitly present in SAVED_MEMORIES.
2. Never invent prices, dates, names, actions, or conclusions.
3. Select the smallest set of memories that directly supports the answer.
4. Prefer the most recent relevant memory when facts conflict.
5. For checklist questions, use the current checked/open state.
6. If no memory supports the question, say that it could not be found.
7. Keep the answer concise and useful.
8. Return strict JSON only.

Return {"answer":"string","primarySourceId":"string or null","sourceIds":["string"],"confidence":0.0,"matchedFacts":["string"],"suggestedAction":"string or null"}.`;

  const DATA_KEY = 'essential-space-data';
  const APPEARANCE_KEY = 'thinksync-appearance';
  const LEGACY_THEME_KEY = 'essential-space-theme';
  const AI_SETTINGS_KEY = 'thinksync-ai-settings';
  const DEMO_INIT_KEY = `thinksync-demo-initialized-v${APP_CONFIG.seedVersion}`;
  const memoryStorage = new Map();

  async function storageGet(key){
    try{
      if(window.storage && typeof window.storage.get === 'function'){
        const result = await window.storage.get(key, false);
        if(result && Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
        if(typeof result === 'string') return result;
      }
    }catch(_error){ /* continue to local fallback */ }
    try{
      const value = window.localStorage.getItem(key);
      if(value !== null) return value;
    }catch(_error){ /* continue to memory fallback */ }
    return memoryStorage.has(key) ? memoryStorage.get(key) : null;
  }

  async function storageSet(key, value){
    const serialized = String(value);
    memoryStorage.set(key, serialized);
    try{
      if(window.storage && typeof window.storage.set === 'function'){
        await window.storage.set(key, serialized, false);
        return true;
      }
    }catch(_error){ /* continue to local fallback */ }
    try{
      window.localStorage.setItem(key, serialized);
      return true;
    }catch(_error){
      return false;
    }
  }

  async function storageRemove(key){
    memoryStorage.delete(key);
    try{
      if(window.storage && typeof window.storage.remove === 'function') await window.storage.remove(key, false);
    }catch(_error){ /* local fallback still runs */ }
    try{ window.localStorage.removeItem(key); }catch(_error){ /* memory is already cleared */ }
    return true;
  }

  function relativeIso({ minutes=0, hours=0, days=0 } = {}){
    return new Date(Date.now() - minutes*60000 - hours*3600000 - days*86400000).toISOString();
  }

  function nextFridayIso(){
    const date = new Date();
    const distance = ((5 - date.getDay() + 7) % 7) || 7;
    date.setDate(date.getDate() + distance);
    date.setHours(17, 0, 0, 0);
    return date.toISOString();
  }

  function createSeedData(){
    const clientTranscript = 'The client wants the dashboard redesigned by next Friday. Keep the existing dark theme, improve the alignment of the cards, add a PDF export button, and do not exceed the fixed budget for this phase.';
    return {
      seedVersion: APP_CONFIG.seedVersion,
      entries: [
        {
          id:'demo-shoes', demoKey:'shoes', type:'screenshot', title:'Black and white running shoes', important:true,
          text:'I liked the clean design and lightweight mesh. Compare it before buying.',
          audio:null, photos:[{ id:'demo-shoes-photo', dataUrl:'assets/demo/running-shoes.svg', alt:'Black and white AeroRun X1 running shoes', caption:'Black-and-white AeroRun X1 running shoes listed for ₹6,499, with UK size 9 selected.' }],
          summaryLines:['Black-and-white running shoes','Price: ₹6,499','Selected size: UK 9','Saved for product comparison'],
          tags:['shoes','shopping','running','product comparison'], synonyms:['shoe option','trainers','sneakers','footwear'],
          questionSeeds:['Compare the shoes I saved','Which running shoes did I like?'],
          recallLine:'AeroRun X1 road runners — ₹6,499, UK 9, black and white; you liked the clean design and lightweight mesh.',
          metadata:{ product:'AeroRun X1', colour:'Black and white', price:'₹6,499', selectedSize:'UK 9', rating:'4.5/5', note:'I liked the clean design and lightweight mesh. Compare it before buying.' },
          createdAt:relativeIso({minutes:35})
        },
        {
          id:'demo-trail-shoes', demoKey:'trail-shoes', type:'screenshot', title:'Trail runners for weekend hikes', important:true,
          text:'Strong grip and a stable heel. This was the rugged option for wet trails and weekend hikes.', audio:null,
          photos:[{ id:'demo-trail-shoes-photo', dataUrl:'assets/demo/trail-shoes.jpg', alt:'Black and olive trail running shoes on a natural surface', caption:'TrailCore Ridge trail runners in black and olive, listed for ₹7,299 with UK size 9 selected.' }],
          summaryLines:['TrailCore Ridge trail runners','Price: ₹7,299','Selected size: UK 9','Saved for grip on wet trails'],
          tags:['shoes','trail shoes','running','hiking','outdoor','grip'], synonyms:['trail runners','trainers','sneakers','footwear','hiking shoes'],
          questionSeeds:['Compare the shoes I saved','Which shoes were for weekend trails?'],
          recallLine:'TrailCore Ridge trail runners — ₹7,299, UK 9, black and olive; you saved them for wet-trail grip and weekend hikes.',
          metadata:{ product:'TrailCore Ridge', colour:'Black and olive', price:'₹7,299', selectedSize:'UK 9', rating:'4.6/5', use:'Wet trails and weekend hikes', note:'Strong grip and a stable heel.' },
          createdAt:relativeIso({minutes:20})
        },
        {
          id:'demo-white-sneakers', demoKey:'white-sneakers', type:'screenshot', title:'Everyday white sneakers', important:false,
          text:'The simple off-white canvas and gum sole would work with most everyday outfits.', audio:null,
          photos:[{ id:'demo-white-sneakers-photo', dataUrl:'assets/demo/white-sneakers.jpg', alt:'Off-white low-top canvas sneakers with gum soles', caption:'Canvas Day Low everyday sneakers in off-white and gum, listed for ₹3,199 with UK size 9 selected.' }],
          summaryLines:['Canvas Day Low sneakers','Price: ₹3,199','Selected size: UK 9','Saved as the everyday option'],
          tags:['shoes','sneakers','casual','shopping','style','everyday'], synonyms:['white shoes','canvas shoes','trainers','footwear'],
          questionSeeds:['Compare the shoes I saved','Which shoes were the everyday option?'],
          recallLine:'Canvas Day Low sneakers — ₹3,199, UK 9, off-white with a gum sole; you saved them as the easy everyday option.',
          metadata:{ product:'Canvas Day Low', colour:'Off-white and gum', price:'₹3,199', selectedSize:'UK 9', rating:'4.3/5', use:'Everyday wear', note:'Simple enough to work with most outfits.' },
          createdAt:relativeIso({minutes:45})
        },
        {
          id:'demo-cafe-notes', demoKey:'cafe-notes', type:'screenshot', title:'Rainy café pitch notes', important:false,
          text:'At Third Lane Café I wrote: make the opening problem one sentence, then show the capture before explaining it. The flat white was ₹220.', audio:null,
          photos:[{ id:'demo-cafe-notes-photo', dataUrl:'assets/demo/cafe-notes.jpg', alt:'Notebook and coffee on a rainy café table', caption:'A notebook and flat white from Third Lane Café, saved while tightening the demo pitch opening.' }],
          summaryLines:['Third Lane Café','Flat white: ₹220','Make the opening problem one sentence','Show capture before explanation'],
          tags:['café','coffee','notebook','pitch','rainy day'], synonyms:['cafe notes','flat white','writing session'],
          questionSeeds:['What did I write at the café?','How much was the flat white?'],
          recallLine:'At Third Lane Café, your ₹220 flat white came with a useful pitch note: make the opening problem one sentence, then show capture first.',
          metadata:{ place:'Third Lane Café', order:'Flat white', price:'₹220', note:'Make the opening problem one sentence, then show capture before explaining it.' },
          createdAt:relativeIso({hours:1})
        },
        {
          id:'demo-keyboard', demoKey:'keyboard', type:'screenshot', title:'Compact keyboard desk upgrade', important:false,
          text:'The 75% layout keeps the arrow keys without taking over the desk. I preferred the graphite case with tactile switches.', audio:null,
          photos:[{ id:'demo-keyboard-photo', dataUrl:'assets/demo/mechanical-keyboard.jpg', alt:'Compact graphite mechanical keyboard on a tidy desk', caption:'KeyFoundry 75 mechanical keyboard in graphite with tactile switches, saved at ₹8,999.' }],
          summaryLines:['KeyFoundry 75 mechanical keyboard','Price: ₹8,999','Graphite case','Tactile switches'],
          tags:['keyboard','desk setup','mechanical','productivity','shopping'], synonyms:['desk upgrade','typing','keycaps','workstation'],
          questionSeeds:['Which keyboard did I save for my desk?','What was my desk upgrade idea?'],
          recallLine:'KeyFoundry 75 keyboard — ₹8,999, graphite, tactile switches; you liked that it keeps arrow keys in a compact layout.',
          metadata:{ product:'KeyFoundry 75', colour:'Graphite', price:'₹8,999', switches:'Tactile', layout:'75%', note:'Keeps arrow keys without taking over the desk.' },
          createdAt:relativeIso({hours:6})
        },
        {
          id:'demo-camera-kit', demoKey:'camera-kit', type:'screenshot', title:'Camera kit for Goa mornings', important:true,
          text:'Pack the mirrorless body, 35 mm prime, two spare batteries, and the small tabletop tripod for the sunrise walk.', audio:null,
          photos:[{ id:'demo-camera-kit-photo', dataUrl:'assets/demo/camera-kit.jpg', alt:'Compact mirrorless camera kit with lens and accessories', caption:'Compact camera kit saved for the Goa sunrise walk: mirrorless body, 35 mm prime, spare batteries, and tabletop tripod.' }],
          summaryLines:['Camera kit for Goa','35 mm prime lens','Pack two spare batteries','Bring the tabletop tripod'],
          tags:['camera','photography','Goa','travel','sunrise','lens'], synonyms:['camera gear','photo kit','travel photography'],
          questionSeeds:['What camera gear did I save for Goa?','What should I pack for sunrise photos?'],
          recallLine:'For Goa sunrise photos, you planned the mirrorless body, 35 mm prime, two spare batteries, and the tabletop tripod.',
          metadata:{ destination:'Goa', use:'Sunrise walk', kit:['Mirrorless body','35 mm prime','Two spare batteries','Tabletop tripod'] },
          createdAt:relativeIso({hours:18})
        },
        {
          id:'demo-plant-corner', demoKey:'plant-corner', type:'screenshot', title:'Monstera corner inspiration', important:false,
          text:'I liked the grouped plants by the bright window. Water the monstera on Sunday and rotate the pot a quarter turn.', audio:null,
          photos:[{ id:'demo-plant-corner-photo', dataUrl:'assets/demo/plant-corner.jpg', alt:'Monstera and smaller houseplants beside a sunny window', caption:'A sunlit plant corner with a monstera, pothos, and a smaller leafy plant on a wood shelf.' }],
          summaryLines:['Sunlit monstera corner','Water on Sunday','Rotate the pot a quarter turn','Group with two smaller plants'],
          tags:['plants','monstera','home','decor','watering'], synonyms:['houseplants','plant shelf','green corner'],
          questionSeeds:['When should I water the monstera?','What plant corner did I like?'],
          recallLine:'You liked a monstera grouped with two smaller plants by a bright window; water it Sunday and rotate the pot a quarter turn.',
          metadata:{ mainPlant:'Monstera', schedule:'Water on Sunday', care:'Rotate the pot a quarter turn', style:'Grouped beside a bright window' },
          createdAt:relativeIso({days:2})
        },
        {
          id:'demo-tomato-pasta', demoKey:'tomato-pasta', type:'screenshot', title:'Creamy tomato pasta for dinner', important:false,
          text:'A 25-minute dinner: rigatoni, cherry tomatoes, garlic, cream, basil, and parmesan. Save a little pasta water for the sauce.', audio:null,
          photos:[{ id:'demo-tomato-pasta-photo', dataUrl:'assets/demo/tomato-pasta.jpg', alt:'Creamy tomato rigatoni with basil and parmesan', caption:'Creamy tomato rigatoni with cherry tomatoes, basil, garlic, cream, and parmesan.' }],
          summaryLines:['Creamy tomato rigatoni','Ready in 25 minutes','Save a little pasta water','Finish with basil and parmesan'],
          tags:['pasta','recipe','dinner','food','cooking'], synonyms:['tomato pasta','rigatoni','quick dinner','meal idea'],
          questionSeeds:['What was that pasta recipe?','What quick dinner did I save?'],
          recallLine:'The creamy tomato rigatoni takes 25 minutes with cherry tomatoes, garlic, cream, basil, and parmesan; save some pasta water for the sauce.',
          metadata:{ dish:'Creamy tomato rigatoni', time:'25 minutes', ingredients:['Rigatoni','Cherry tomatoes','Garlic','Cream','Basil','Parmesan'], tip:'Save a little pasta water for the sauce.' },
          createdAt:relativeIso({days:2,hours:4})
        },
        {
          id:'demo-headphones', demoKey:'headphones', type:'screenshot', title:'Midnight blue focus headphones', important:false,
          text:'Noise cancelling, comfortable over-ear fit, and multipoint pairing. Saved for flights and focused work.', audio:null,
          photos:[{ id:'demo-headphones-photo', dataUrl:'assets/demo/noise-cancelling-headphones.jpg', alt:'Midnight blue over-ear headphones on a wooden desk', caption:'QuietArc H7 noise-cancelling headphones in midnight blue, listed for ₹12,499.' }],
          summaryLines:['QuietArc H7 headphones','Price: ₹12,499','Midnight blue','Saved for flights and focused work'],
          tags:['headphones','audio','focus','travel','shopping'], synonyms:['noise cancelling','over ear','ANC','flight headphones'],
          questionSeeds:['Which headphones did I save for focus?','How much were the blue headphones?'],
          recallLine:'QuietArc H7 headphones — ₹12,499 in midnight blue, with noise cancelling and multipoint pairing for flights and focused work.',
          metadata:{ product:'QuietArc H7', colour:'Midnight blue', price:'₹12,499', features:['Noise cancelling','Multipoint pairing','Over-ear fit'], use:'Flights and focused work' },
          createdAt:relativeIso({days:3,hours:2})
        },
        {
          id:'demo-backpack', demoKey:'backpack', type:'screenshot', title:'Carry-on backpack shortlist', important:false,
          text:'The 32 L black carry-on opens flat, has a padded laptop sleeve, and stays within cabin limits. Saved at ₹5,799.', audio:null,
          photos:[{ id:'demo-backpack-photo', dataUrl:'assets/demo/carry-on-backpack.jpg', alt:'Black carry-on backpack packed for a short trip', caption:'Roam 32 L carry-on backpack in black, listed for ₹5,799 with a clamshell opening and laptop sleeve.' }],
          summaryLines:['Roam 32 L carry-on backpack','Price: ₹5,799','Black, cabin-sized','Clamshell opening and laptop sleeve'],
          tags:['backpack','travel','carry-on','bag','shopping'], synonyms:['cabin bag','travel backpack','luggage','pack'],
          questionSeeds:['Which carry-on backpack did I save?','What travel bag was on my shortlist?'],
          recallLine:'Roam 32 L carry-on backpack — ₹5,799 in black, cabin-sized, with a clamshell opening and padded laptop sleeve.',
          metadata:{ product:'Roam 32 L', colour:'Black', price:'₹5,799', capacity:'32 L', features:['Clamshell opening','Padded laptop sleeve','Cabin-sized'] },
          createdAt:relativeIso({days:4,hours:2})
        },
        {
          id:'demo-winter-jacket', demoKey:'winter-jacket', type:'screenshot', title:'Charcoal winter jacket', important:false,
          text:'Warm but simple enough for daily wear. I saved the charcoal colour in size M for the December trip.', audio:null,
          photos:[{ id:'demo-winter-jacket-photo', dataUrl:'assets/demo/winter-jacket.jpg', alt:'Charcoal winter jacket beside a cream scarf', caption:'Northline insulated winter jacket in charcoal, size M, listed for ₹6,899.' }],
          summaryLines:['Northline insulated jacket','Price: ₹6,899','Charcoal, size M','Saved for the December trip'],
          tags:['jacket','winter','clothing','December','shopping'], synonyms:['coat','outerwear','warm jacket','travel clothes'],
          questionSeeds:['Which jacket did I save for December?','What size was the winter jacket?'],
          recallLine:'Northline insulated jacket — ₹6,899, charcoal, size M; you saved it for the December trip and everyday wear.',
          metadata:{ product:'Northline insulated jacket', colour:'Charcoal', price:'₹6,899', selectedSize:'M', use:'December trip and daily wear' },
          createdAt:relativeIso({days:5})
        },
        {
          id:'demo-client-call', demoKey:'client-call', type:'voice', title:'Client call — dashboard redesign', important:true,
          text:'Fixed-scope dashboard redesign requirements.', transcript:clientTranscript, audioText:clientTranscript, audio:null, photos:[],
          summaryLines:['Dashboard redesign due next Friday','Preserve the existing dark theme','Improve card alignment and spacing','Add PDF export','Budget is fixed for this phase'],
          tags:['client','dashboard','redesign','PDF export','dark theme','fixed budget'], synonyms:['client request','dashboard changes','call notes'],
          questionSeeds:['What did the client request?'],
          recallLine:'The client wants the dark theme preserved, tighter card alignment, PDF export, and delivery by next Friday within the fixed budget.',
          metadata:{ dueLabel:'next Friday', dueDate:nextFridayIso(), theme:'existing dark theme', changes:['improve card alignment','add PDF export'], budget:'fixed for this phase' },
          createdAt:relativeIso({hours:2})
        },
        {
          id:'demo-goa-trip', demoKey:'goa-trip', type:'screenshot', title:'Goa flight confirmation', important:false,
          text:'Remaining action: shortlist three beach stays under ₹7,000 per night.', audio:null,
          photos:[{ id:'demo-goa-photo', dataUrl:'assets/demo/goa-itinerary.svg', alt:'Fictional Goa return flight itinerary', caption:'Return flight itinerary to Goa for 12–16 December 2026, booked for ₹8,420.' }],
          summaryLines:['Goa return flight booked','12–16 December 2026','Total fare: ₹8,420','Shortlist three beach stays under ₹7,000 per night'],
          tags:['Goa','travel','flight','December','itinerary'], synonyms:['holiday','trip dates','beach stay'],
          questionSeeds:['What did I save for Goa?','When is my Goa trip?'],
          recallLine:'Your Goa flights are booked for 12–16 December 2026 at ₹8,420; you still need to shortlist three beach stays under ₹7,000 per night.',
          metadata:{ destination:'Goa', dates:'12–16 December 2026', returnBooked:true, fare:'₹8,420', remainingAction:'Shortlist three beach stays under ₹7,000 per night' },
          createdAt:relativeIso({days:1})
        },
        {
          id:'demo-project-idea', demoKey:'project-idea', type:'note', title:'AI memory hub pitch idea', important:false,
          text:'Lead the pitch with the problem of losing useful information inside screenshots, voice notes, tabs, and chats. Demonstrate capture first, then ask a natural-language question and reveal the original source.',
          audio:null, photos:[], summaryLines:['Lead with information overload','Demonstrate capture before explaining architecture','End with semantic recall and source evidence'],
          tags:['pitch','AI memory hub','demo structure','information overload'], synonyms:['presentation','talk structure','demo narrative'],
          questionSeeds:['How should I structure the pitch?'],
          recallLine:'For the pitch: open with information overload, demonstrate capture, ask a natural-language question, then reveal the original source.',
          metadata:{ structure:['Start with the information-overload problem','Demonstrate capture','Ask a natural-language question','Reveal the original source'] },
          createdAt:relativeIso({days:3})
        },
        {
          id:'demo-research', demoKey:'research', type:'screenshot', title:'Research — context improves recall', important:false,
          text:'Useful framing for the pitch: visible source context makes recalled answers easier to trust.', audio:null,
          photos:[{ id:'demo-research-photo', dataUrl:'assets/demo/research-article.svg', alt:'Saved research article about source context and digital memory', caption:'Research article explaining why visible source context improves trust in digital recall.' }],
          summaryLines:['Source context improves recall confidence','Evidence should be visible beside the answer'],
          tags:['research','memory','source context','provenance','trust'], synonyms:['article','evidence','grounded answer'],
          metadata:{ readingTime:'6 min', topic:'source-backed digital memory' }, createdAt:relativeIso({days:4})
        },
        {
          id:'demo-voice-idea', demoKey:'voice-idea', type:'voice', title:'Quick idea — capture without friction', important:false,
          text:'A short product thought.', transcript:'The capture flow should take one action, then let the user add details only when they are useful.',
          audioText:'The capture flow should take one action, then let the user add details only when they are useful.', audio:null, photos:[],
          summaryLines:['Capture in one action','Make extra details optional'], tags:['idea','capture','product'], synonyms:['voice idea','friction'],
          metadata:{ theme:'low-friction capture' }, createdAt:relativeIso({hours:5})
        },
        {
          id:'demo-meeting-note', demoKey:'meeting-note', type:'note', title:'Team sync — demo handoff', important:false,
          text:'Keep the rehearsal under two minutes. Show one capture, two grounded answers, then the checklist changing live. Keep a backup recording on the laptop.',
          audio:null, photos:[], summaryLines:['Two-minute rehearsal','One capture and two grounded answers','Show live checklist state','Keep a local backup recording'],
          tags:['meeting','demo','rehearsal','handoff'], synonyms:['team sync','practice'], metadata:{ duration:'two minutes' }, createdAt:relativeIso({days:1,hours:3})
        },
        {
          id:'demo-design-inspiration', demoKey:'design-inspiration', type:'screenshot', title:'Dashboard alignment inspiration', important:false,
          text:'Keep the visual rhythm compact: consistent left edges, equal panel heights, and restrained accent use.', audio:null,
          photos:[{ id:'demo-design-photo', dataUrl:'assets/demo/design-inspiration.svg', alt:'Dark dashboard alignment inspiration', caption:'Dark interface reference with aligned cards, equal panel heights, and restrained red accents.' }],
          summaryLines:['Consistent left edges','Equal panel heights','Restrained accent use'],
          tags:['design','dashboard','alignment','dark interface'], synonyms:['UI inspiration','card spacing'], metadata:{ style:'minimal dark interface' }, createdAt:relativeIso({days:6})
        }
      ],
      checklists: [
        {
          id:'demo-hackathon', demoKey:'hackathon', title:'Hackathon submission', important:true, createdAt:relativeIso({minutes:50}),
          tags:['hackathon','submission','tasks','pitch'], synonyms:['things left to submit','remaining tasks','submission tasks'],
          questionSeeds:['What is left for the hackathon?'],
          items:[
            {id:'hack-name',text:'Finalise product name',checked:true},
            {id:'hack-memories',text:'Prepare sample memories',checked:true},
            {id:'hack-charger',text:'Check laptop charger',checked:true},
            {id:'hack-pitch',text:'Rehearse the two-minute pitch',checked:false},
            {id:'hack-offline',text:'Test the app in offline mode',checked:false},
            {id:'hack-backup',text:'Export a backup demo recording',checked:false},
            {id:'hack-slide',text:'Add the final team slide',checked:false}
          ]
        },
        {
          id:'demo-groceries', demoKey:'groceries', title:'Groceries', important:false, createdAt:relativeIso({hours:4}),
          tags:['groceries','shopping','food'], synonyms:['grocery list','things to buy'],
          questionSeeds:['What groceries do I still need?'],
          items:[
            {id:'grocery-milk',text:'Milk',checked:true},
            {id:'grocery-eggs',text:'Eggs',checked:false},
            {id:'grocery-bread',text:'Bread',checked:false},
            {id:'grocery-coffee',text:'Coffee',checked:true},
            {id:'grocery-vegetables',text:'Vegetables',checked:false}
          ]
        }
      ]
    };
  }

  /* ============ ICONS ============ */
  const ICONS = {
    close:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    play:'<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    pause:'<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    trash:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
    plus:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    check:'<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    back:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    image:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    mic:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    camera:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    stop:'<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    upload:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    reset:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>',
    edit:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
    note:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    checklist:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><path d="M3.5 6l1 1 2-2"/><path d="M3.5 12l1 1 2-2"/><path d="M3.5 18l1 1 2-2"/></svg>',
    star:'<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    sparkle:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6z"/><path d="M19 15l.8 2.4L22 18l-2.2.6L19 21l-.8-2.4L16 18l2.2-.6z"/></svg>',
  };

  /* ============ STATE ============ */
  const state = {
    data: { entries: [], checklists: [] },
    appSettings: { aiSummaries:true },
    view: 'home',
    prevView: 'home',
    searchQuery: '',
    playingId: null,
    currentAudio: null,
    currentUtterance: null,
    modal: null,
    draft: {},
    firstRun: false,
    libraryUpgraded: false,
    focusChecklistId: null,
  };

  const $ = sel => document.querySelector(sel);
  const viewContainer = $('#view-container');
  const modalRoot = $('#modal-root');

  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
  function esc(str){
    if(str===undefined||str===null) return '';
    return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function fmtTime(iso){
    const d = new Date(iso);
    if(Number.isNaN(d.getTime())) return 'DATE UNAVAILABLE';
    const days=['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const hh=String(d.getHours()).padStart(2,'0'), mm=String(d.getMinutes()).padStart(2,'0');
    return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} · ${hh}:${mm}`;
  }
  function showToast(msg){
    const el = document.createElement('div');
    el.className='toast';
    el.textContent = msg;
    $('#toast-root').appendChild(el);
    setTimeout(()=>el.remove(), 3200);
  }

  /* ============ STORAGE ============ */
  function mergeLatestSampleLibrary(){
    const latest = createSeedData();
    latest.entries.forEach(sample=>{
      const index = state.data.entries.findIndex(item=>item.demoKey===sample.demoKey);
      if(index<0){ state.data.entries.push(sample); return; }
      const existing = state.data.entries[index];
      state.data.entries[index] = Object.assign({}, existing, sample, {
        id:existing.id || sample.id,
        important:typeof existing.important==='boolean' ? existing.important : sample.important,
        createdAt:existing.createdAt || sample.createdAt
      });
    });
    latest.checklists.forEach(sample=>{
      const index = state.data.checklists.findIndex(item=>item.demoKey===sample.demoKey);
      if(index<0){ state.data.checklists.push(sample); return; }
      const existing = state.data.checklists[index];
      const checkedById = new Map((existing.items||[]).map(item=>[item.id,!!item.checked]));
      const sampleIds = new Set(sample.items.map(item=>item.id));
      const extraItems = (existing.items||[]).filter(item=>!sampleIds.has(item.id));
      state.data.checklists[index] = Object.assign({}, existing, sample, {
        id:existing.id || sample.id,
        important:typeof existing.important==='boolean' ? existing.important : sample.important,
        createdAt:existing.createdAt || sample.createdAt,
        items:[...sample.items.map(item=>Object.assign({},item,checkedById.has(item.id)?{checked:checkedById.get(item.id)}:{})),...extraItems]
      });
    });
    state.data.seedVersion = APP_CONFIG.seedVersion;
  }

  async function loadData(){
    const raw = await storageGet(DATA_KEY);
    if(raw){
      try{
        const parsed = JSON.parse(raw);
        state.data.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        state.data.checklists = Array.isArray(parsed.checklists) ? parsed.checklists : [];
        state.data.seedVersion = parsed.seedVersion || null;
        if((Number(parsed.seedVersion)||0) < APP_CONFIG.seedVersion){
          mergeLatestSampleLibrary();
          state.libraryUpgraded = true;
          await saveData();
        }
      }catch(_error){
        state.data = createSeedData();
        state.firstRun = true;
        await saveData();
      }
    }else{
      state.data = createSeedData();
      state.firstRun = true;
      await saveData();
    }
    const settingsRaw = await storageGet(AI_SETTINGS_KEY);
    if(settingsRaw){
      try{ state.appSettings = Object.assign(state.appSettings, JSON.parse(settingsRaw)); }catch(_error){ /* keep safe defaults */ }
    }
  }
  async function saveData(){
    return storageSet(DATA_KEY, JSON.stringify(state.data));
  }

  async function saveAppSettings(){
    return storageSet(AI_SETTINGS_KEY, JSON.stringify(state.appSettings));
  }

  function upsertDemoEntry(entry){
    const index = state.data.entries.findIndex(item => item.demoKey && item.demoKey === entry.demoKey);
    if(index >= 0){
      const existing = state.data.entries[index];
      state.data.entries[index] = Object.assign({}, existing, entry, { id:existing.id || entry.id, createdAt:new Date().toISOString() });
      return state.data.entries[index];
    }
    state.data.entries.push(entry);
    return entry;
  }

  async function restoreSampleMemories(){
    stopPlayback();
    const seed = createSeedData();
    seed.entries.forEach(sample=>{
      const index = state.data.entries.findIndex(item=>item.demoKey===sample.demoKey);
      if(index >= 0) state.data.entries[index] = sample;
      else state.data.entries.push(sample);
    });
    seed.checklists.forEach(sample=>{
      const index = state.data.checklists.findIndex(item=>item.demoKey===sample.demoKey);
      if(index >= 0) state.data.checklists[index] = sample;
      else state.data.checklists.push(sample);
    });
    state.data.seedVersion = APP_CONFIG.seedVersion;
    await saveData();
    state.searchQuery=''; $('#search-input').value='';
    setView('home');
    showToast('Sample memories restored');
  }

  async function resetDemoLibrary(){
    if(!window.confirm('Restore the complete demo library and reset its checklist progress? Your theme will be kept.')) return;
    stopPlayback();
    state.data = createSeedData();
    await saveData();
    await storageSet(DEMO_INIT_KEY, String(APP_CONFIG.seedVersion));
    state.searchQuery=''; $('#search-input').value='';
    closeModal();
    setView('home');
    showToast('Demo library restored');
  }

  async function clearUserCreatedMemories(){
    if(!window.confirm('Remove memories you created while keeping the sample library?')) return;
    state.data.entries = state.data.entries.filter(item=>!!item.demoKey);
    state.data.checklists = state.data.checklists.filter(item=>!!item.demoKey);
    await saveData();
    setView('home');
    showToast('User-created memories cleared');
  }

  /* ============ APPEARANCE ENGINE (mode x accent, independent axes) ============ */
  const MODES = {
    dark:  { bg:'#0a0a0b', bgSecondary:'#050506', surface:'#141416', surfaceEl:'#1c1c1f', border:'#242426', divider:'#1b1b1d', text:'#f2f2f0', textSec:'#9a9a97', textMuted:'#858581' },
    light: { bg:'#f4f2ee', bgSecondary:'#eae7e1', surface:'#ffffff', surfaceEl:'#f1efea', border:'#ddd8cf', divider:'#e6e2da', text:'#1a1917', textSec:'#5c584f', textMuted:'#6f6b64' },
  };
  const ACCENTS = [
    { id:'nothing-red', name:'Nothing Red', accent:'#ff2a1f', accentHover:'#ff4438' },
    { id:'ocean-blue', name:'Ocean Blue', accent:'#2ea6ff', accentHover:'#57b8ff' },
    { id:'matte-green', name:'Matte Green', accent:'#3fae6a', accentHover:'#59c684' },
    { id:'purple', name:'Purple', accent:'#8a5cf6', accentHover:'#a17cf8' },
    { id:'amber', name:'Amber', accent:'#ffb020', accentHover:'#ffc352' },
    { id:'slate', name:'Slate', accent:'#7c8a9c', accentHover:'#93a0b0' },
    { id:'graphite', name:'Graphite', accent:'#9a9a97', accentHover:'#b3b3b0' },
    { id:'rose', name:'Rose', accent:'#f65c8a', accentHover:'#f97ea3' },
    { id:'arctic-cyan', name:'Arctic Cyan', accent:'#38e0ff', accentHover:'#69e8ff' },
    { id:'emerald', name:'Emerald', accent:'#1fbf83', accentHover:'#38d69a' },
    { id:'white', name:'White', accent:'#f2f2f0', accentHover:'#d8d8d5' },
    { id:'black', name:'Black', accent:'#0a0a0a', accentHover:'#242424' },
  ];
  let appearance = { mode:'dark', accentId:'nothing-red', customColor:'#ff2a1f', tinted:false, reducedMotion:false, highContrast:false };

  function hexToRgba(hex, a){
    const h = hex.replace('#','');
    const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
    return `rgba(${r},${g},${b},${a})`;
  }
  function shade(hex, amt){
    const h = hex.replace('#','');
    let r=parseInt(h.substring(0,2),16), g=parseInt(h.substring(2,4),16), b=parseInt(h.substring(4,6),16);
    r=Math.min(255,Math.round(r+(255-r)*amt)); g=Math.min(255,Math.round(g+(255-g)*amt)); b=Math.min(255,Math.round(b+(255-b)*amt));
    return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  function mixHex(hexA, hexB, t){
    const a = hexA.replace('#',''), b = hexB.replace('#','');
    const ar=parseInt(a.substring(0,2),16), ag=parseInt(a.substring(2,4),16), ab=parseInt(a.substring(4,6),16);
    const br=parseInt(b.substring(0,2),16), bg=parseInt(b.substring(2,4),16), bb=parseInt(b.substring(4,6),16);
    const r=Math.round(ar+(br-ar)*t), g=Math.round(ag+(bg-ag)*t), bl=Math.round(ab+(bb-ab)*t);
    return '#'+[r,g,bl].map(v=>Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join('');
  }

  function applyAppearance(save){
    const m = MODES[appearance.mode] || MODES.dark;
    const accentDef = appearance.accentId==='custom'
      ? { accent: appearance.customColor||'#ff2a1f', accentHover: shade(appearance.customColor||'#ff2a1f', 0.18) }
      : (ACCENTS.find(a=>a.id===appearance.accentId) || ACCENTS[0]);

    let bg, bgSecondary, surface, surfaceEl, border, divider, accentOut, accentHoverOut;

    if(appearance.tinted){
      const base = appearance.mode==='dark' ? '#000000' : '#ffffff';
      const pop  = appearance.mode==='dark' ? '#f5f5f2' : '#15140f';
      bg           = mixHex(accentDef.accent, base, 0.88);
      bgSecondary  = mixHex(accentDef.accent, base, 0.93);
      surface      = mixHex(accentDef.accent, base, 0.80);
      surfaceEl    = mixHex(accentDef.accent, base, 0.71);
      border       = mixHex(accentDef.accent, base, 0.55);
      divider      = mixHex(accentDef.accent, base, 0.68);
      accentOut      = pop;
      accentHoverOut = mixHex(pop, base, 0.14);
    } else {
      bg = m.bg; bgSecondary = m.bgSecondary; surface = m.surface; surfaceEl = m.surfaceEl;
      border = m.border; divider = m.divider;
      accentOut = accentDef.accent; accentHoverOut = accentDef.accentHover;
    }

    if(appearance.highContrast){
      border  = appearance.mode==='light' ? '#a39d8f' : '#4a4a4a';
      divider = appearance.mode==='light' ? '#a39d8f' : '#3a3a3a';
    }

    const root = document.documentElement.style;
    root.setProperty('--bg', bg);
    root.setProperty('--bg-secondary', bgSecondary);
    root.setProperty('--surface', surface);
    root.setProperty('--surface-elevated', surfaceEl);
    root.setProperty('--border', border);
    root.setProperty('--divider', divider);
    root.setProperty('--text-primary', m.text);
    root.setProperty('--text-secondary', appearance.highContrast ? m.text : m.textSec);
    root.setProperty('--text-muted', appearance.highContrast ? (appearance.mode==='light' ? '#3a3833' : '#c8c8c5') : m.textMuted);
    root.setProperty('--accent', accentOut);
    root.setProperty('--accent-hover', accentHoverOut);
    root.setProperty('--accent-soft', hexToRgba(accentOut, 0.14));
    root.setProperty('--accent-soft-strong', hexToRgba(accentOut, 0.28));
    root.setProperty('--focus-ring', hexToRgba(accentOut, 0.55));
    root.setProperty('--selection', hexToRgba(accentOut, 0.28));
    document.documentElement.classList.toggle('tinted', !!appearance.tinted);
    document.documentElement.classList.toggle('reduce-motion', !!appearance.reducedMotion);
    document.body.style.setProperty('--dur-fast', appearance.reducedMotion ? '0ms' : '120ms');
    document.body.style.setProperty('--dur-normal', appearance.reducedMotion ? '0ms' : '200ms');
    document.body.style.setProperty('--dur-slow', appearance.reducedMotion ? '0ms' : '320ms');
    document.body.style.setProperty('--dur-theme', appearance.reducedMotion ? '0ms' : '340ms');
    if(state.view==='settings') renderSettings();
    if(save) storageSet(APPEARANCE_KEY, JSON.stringify(appearance));
  }

  async function loadTheme(){
    try{
      const raw = await storageGet(APPEARANCE_KEY);
      if(raw){
        const savedAppearance=JSON.parse(raw);
        if(savedAppearance.invert !== undefined && savedAppearance.tinted === undefined) savedAppearance.tinted=savedAppearance.invert;
        appearance = Object.assign(appearance, savedAppearance);
        delete appearance.invert;
        applyAppearance(false);
        return;
      }
    }catch(e){ /* fall through to legacy */ }
    try{
      const legacy = await storageGet(LEGACY_THEME_KEY);
      if(legacy){
        const id = JSON.parse(legacy);
        const map = { 'nothing-red':'nothing-red', 'ocean-blue':'ocean-blue', 'matrix-green':'matte-green', 'amber-terminal':'amber', 'violet-neon':'purple' };
        appearance.mode = id==='paper-light' ? 'light' : 'dark';
        appearance.accentId = map[id] || 'nothing-red';
      }
    }catch(e){ /* use defaults */ }
    applyAppearance(false);
  }

  /* ============ CLOCK & GREETING ============ */
  function updateClock(){
    const now = new Date();
    const days=['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    $('#clock-time').textContent = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
    $('#clock-date').textContent = days[now.getDay()]+', '+months[now.getMonth()]+' '+now.getDate();
  }
  function updateGreeting(){
    const h = new Date().getHours();
    const word = h<5 ? 'Good night.' : h<12 ? 'Good morning.' : h<17 ? 'Good afternoon.' : h<21 ? 'Good evening.' : 'Good night.';
    $('#greeting-text').textContent = word;
    const openItems = state.data.checklists.reduce((n,c)=> n + c.items.filter(i=>!i.checked).length, 0);
    const sub = $('#greeting-sub');
    if(openItems){
      sub.textContent = `${openItems} thing${openItems===1?'':'s'} still open.`;
      sub.classList.remove('is-hidden');
    } else {
      sub.textContent = '';
      sub.classList.add('is-hidden');
    }
  }

  /* ============ DATA HELPERS ============ */
  function allEntries(){ return [...state.data.entries].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt)); }
  function allChecklists(){ return [...state.data.checklists].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt)); }
  function splitImportant(list, isImportantFn){
    const test = isImportantFn || (x=>x.important);
    return { imp: list.filter(test), rest: list.filter(x=>!test(x)) };
  }
  function importantFirstHtml(list, cardFn, isImportantFn){
    const { imp, rest } = splitImportant(list, isImportantFn);
    let out = '';
    if(imp.length){ out += `<div class="list-subheading">Important</div>` + imp.map(cardFn).join(''); }
    if(imp.length && rest.length){ out += `<div class="list-subheading">Recent</div>`; }
    out += rest.map(cardFn).join('');
    return out;
  }
  function findEntry(id){ return state.data.entries.find(e=>e.id===id); }
  function findChecklist(id){ return state.data.checklists.find(c=>c.id===id); }
  function allPhotosFlat(){
    const out=[];
    allEntries().forEach(e=>{ (e.photos||[]).forEach(p=> out.push({ photo:p, entry:e })); });
    return out;
  }
  function normalizeText(value){
    return String(value || '')
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[’']/g,'')
      .replace(/[^a-z0-9₹]+/g,' ')
      .trim()
      .replace(/\s+/g,' ');
  }
  function singularToken(token){
    if(token==='groceries') return 'grocery';
    if(token==='things') return 'thing';
    if(token.endsWith('ies') && token.length>4) return token.slice(0,-3)+'y';
    if(token.endsWith('s') && token.length>3) return token.slice(0,-1);
    return token;
  }
  function flattenMetadata(value){
    if(value===null || value===undefined) return [];
    if(Array.isArray(value)) return value.flatMap(flattenMetadata);
    if(typeof value==='object') return Object.values(value).flatMap(flattenMetadata);
    return [String(value)];
  }
  function searchDocumentForEntry(e){
    return [e.title,e.text,e.transcript,e.audioText,e.recallLine,...(e.summaryLines||[]),...(e.tags||[]),...(e.synonyms||[]),...(e.questionSeeds||[]),...(e.photos||[]).flatMap(p=>[p.caption,p.alt]),...flattenMetadata(e.metadata)].filter(Boolean).join(' ');
  }
  function searchDocumentForChecklist(c){
    return [c.title,...(c.tags||[]),...(c.synonyms||[]),...(c.questionSeeds||[]),...(c.items||[]).map(item=>item.text)].filter(Boolean).join(' ');
  }
  function tokenSearchScore(documentText, query){
    if(!query) return 1;
    const doc = normalizeText(documentText);
    const normalizedQuery = normalizeText(query);
    if(!normalizedQuery) return 1;
    let score = doc.includes(normalizedQuery) ? 14 : 0;
    const docTokens = doc.split(' ').filter(Boolean);
    const docStems = new Set(docTokens.map(singularToken));
    const queryTokens = normalizedQuery.split(' ').filter(Boolean);
    queryTokens.forEach(token=>{
      const stem = singularToken(token);
      if(docStems.has(stem)) score += 3;
      else if(docTokens.some(candidate=>candidate.includes(token) || token.includes(candidate))) score += 1;
    });
    return score;
  }
  function searchScoreEntry(e,q){ return tokenSearchScore(searchDocumentForEntry(e),q); }
  function searchScoreChecklist(c,q){ return tokenSearchScore(searchDocumentForChecklist(c),q); }
  function matchesEntry(e, q){ return !q || searchScoreEntry(e,q)>0; }
  function matchesChecklist(c, q){ return !q || searchScoreChecklist(c,q)>0; }

  /* ============ ROUTER ============ */
  function setView(v){
    state.view = v;
    document.querySelectorAll('.nav-item[data-view]').forEach(b=>{
      b.classList.toggle('active', b.dataset.view===v);
    });
    render();
  }

  const SEARCH_PLACEHOLDERS = {
    home: 'Search your mind...',
    important: 'Search important...',
    'all-notes': 'Search notes...',
    'all-voice': 'Search recordings...',
    'all-visual': 'Search screenshots...',
    'all-checklists': 'Search checklists...',
    files: 'Search files...',
    settings: 'Search settings...',
  };
  function updateSearchPlaceholder(){
    const input = $('#search-input');
    if(!input) return;
    const key = state.view==='search' ? (state.prevView||'home') : state.view;
    input.placeholder = SEARCH_PLACEHOLDERS[key] || 'Search your mind...';
  }

  function render(){
    updateSearchPlaceholder();
    if(state.view==='home') return renderHome();
    if(state.view==='important') return renderImportant();
    if(state.view==='all-notes') return renderAllNotes();
    if(state.view==='all-voice') return renderAllVoice();
    if(state.view==='all-visual') return renderAllVisual();
    if(state.view==='all-checklists') return renderAllChecklists();
    if(state.view==='files') return renderFiles();
    if(state.view==='search') return renderSearch();
    if(state.view==='settings') return renderSettings();
  }

  /* ---------- HOME ---------- */
  function renderHome(){
    updateGreeting();
    const entries = allEntries();
    const checklists = allChecklists();
    const continuing = entries[0];
    const pendingChecklists = checklists.slice(0,4);
    const voiceEntries = entries.filter(e=>e.type==='voice').slice(0,4);
    const photos = allPhotosFlat().slice(0,6);
    const importantItems = [...entries, ...checklists]
      .filter(x=>x.important)
      .sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt))
      .slice(0,4);

    let html = `
      <section class="section">
        <div class="section-label">Quick actions</div>
        <div class="quick-actions">
          <button class="quick-action-btn" data-open="note"><span class="qa-icon">${ICONS.note}</span><span class="qa-label">New note</span></button>
          <button class="quick-action-btn" data-open="voice"><span class="qa-icon">${ICONS.mic}</span><span class="qa-label">New voice note</span></button>
          <button class="quick-action-btn" data-open="screenshot"><span class="qa-icon">${ICONS.camera}</span><span class="qa-label">New screenshot</span></button>
          <button class="quick-action-btn" data-open="checklist"><span class="qa-icon">${ICONS.checklist}</span><span class="qa-label">New checklist</span></button>
          <button class="quick-action-btn" data-open="ask"><span class="qa-icon">${ICONS.sparkle}</span><span class="qa-label">Ask AI</span></button>
        </div>
      </section>`;

    if(continuing){
      const kindLabel = {note:'Note', voice:'Voice note', screenshot:'Screenshot'}[continuing.type];
      const snippet = continuing.text || (continuing.photos && continuing.photos[0] && continuing.photos[0].caption) || (continuing.summaryLines && continuing.summaryLines[0]) || 'Open to see more';
      html += `
        <section class="section">
          <div class="section-label">Continue working</div>
          <div class="spotlight-card" data-detail="${continuing.id}">
            <div style="min-width:0;">
              <div class="spotlight-type">${kindLabel}</div>
              <div class="spotlight-title">${esc(continuing.title||'Untitled')}</div>
              <div class="spotlight-snippet">${esc(snippet)}</div>
            </div>
            <span class="spotlight-arrow">→</span>
          </div>
        </section>`;
    }

    if(importantItems.length){
      html += `
        <section class="section">
          <div class="section-label-row">
            <div class="section-label">Important</div>
            <button class="section-link" data-goto="important">See all →</button>
          </div>
          <div class="panel">
            <div class="panel-body" style="max-height:none;">
              ${importantItems.map(importantRowHtml).join('')}
            </div>
          </div>
        </section>`;
    }

    if(pendingChecklists.length){
      html += `
        <section class="section">
          <div class="section-label-row">
            <div class="section-label">Checklists</div>
            <button class="section-link" data-goto="all-checklists">See all →</button>
          </div>
          <div class="panel">
            <div class="panel-body" style="max-height:none;">
              ${pendingChecklists.map(c=>`
                <div class="check-row" data-goto-checklist="${c.id}">
                  <span class="checkbox"></span>
                  <span class="item-text">${esc(c.title)} · ${c.items.filter(i=>i.checked).length}/${c.items.length}</span>
                </div>`).join('')}
            </div>
          </div>
        </section>`;
    }

    html += `
      <section class="section">
        <div class="section-label">Recent</div>
        <div class="two-col">
          <div class="panel">
            <header class="panel-head" data-goto="all-voice"><h2>Voice notes</h2><span class="chev">→</span></header>
            <div class="panel-body">
              ${voiceEntries.length ? voiceEntries.map(voiceRowHtml).join('') : emptyHint('No voice notes yet','voice')}
            </div>
          </div>
          <div class="panel">
            <header class="panel-head" data-goto="all-visual"><h2>Visual feed</h2><span class="chev">→</span></header>
            <div class="panel-body">
              ${photos.length ? `<div class="thumb-grid">${photos.map(p=>thumbHtml(p.photo,p.entry)).join('')}</div>` : emptyHint('No photos yet','screenshot')}
            </div>
          </div>
        </div>
      </section>

      <div class="everything-else">
        <button data-goto="files">See all →</button>
      </div>
    `;

    viewContainer.innerHTML = html;
    bindHomeEvents();
  }

  function emptyHint(msg, openType){
    return `<div class="empty-hint"><span>${esc(msg)}</span><button data-open="${openType}">+ Add one</button></div>`;
  }
  function voiceRowHtml(e){
    const isPlaying = state.playingId===e.id;
    const ai = e.summaryLines && e.summaryLines[0] ? `<div class="voice-ai">${esc(e.summaryLines[0])}</div>` : '';
    return `
      <div class="voice-row" data-entry-row="${e.id}">
        <button class="play-btn" data-play="${e.id}" aria-label="Play voice note">${isPlaying?ICONS.pause:ICONS.play}</button>
        <div class="voice-meta" data-detail="${e.id}">
          <div class="voice-title">${esc(e.title || 'Untitled voice note')}</div>
          <div class="voice-time">${fmtTime(e.createdAt)}</div>
          ${ai}
        </div>
      </div>`;
  }
  function thumbHtml(photo, entry){
    return `<div class="thumb" role="img" aria-label="${esc(photo.alt||photo.caption||entry.title||'Saved image')}" style="background-image:url('${photo.dataUrl}')" data-detail="${entry.id}">
      <div class="thumb-tag">${esc((photo.caption||'').slice(0,40))}</div>
    </div>`;
  }
  function checklistPreviewHtml(c){
    const items = c.items.slice(0,6);
    const done = c.items.filter(i=>i.checked).length;
    return `
      <div class="checklist-title-mini">${esc(c.title)} · ${done}/${c.items.length}</div>
      ${items.map(it=>checkRowHtml(c.id, it)).join('')}
    `;
  }
  function checkRowHtml(checklistId, item){
    return `
      <label class="check-row ${item.checked?'checked':''}" data-toggle-item="${checklistId}|${item.id}">
        <span class="checkbox">${ICONS.check}</span>
        <span class="item-text">${esc(item.text)}</span>
      </label>`;
  }
  function importantRowHtml(item){
    const isChecklist = Array.isArray(item.items);
    const kindLabel = isChecklist ? 'Checklist' : {note:'Note', voice:'Voice note', screenshot:'Screenshot'}[item.type];
    const snippet = isChecklist
      ? `${item.items.filter(i=>i.checked).length}/${item.items.length} steps complete`
      : (item.text || (item.photos && item.photos[0] && item.photos[0].caption) || (item.summaryLines && item.summaryLines[0]) || '');
    const attr = isChecklist ? `data-goto-checklist="${item.id}"` : `data-detail="${item.id}"`;
    return `
      <div class="important-row" ${attr}>
        <span class="important-star">${ICONS.star}</span>
        <div style="min-width:0;">
          <div class="important-row-title">${esc(item.title||'Untitled')}</div>
          <div class="important-row-sub">${esc(kindLabel)}${snippet ? ' · '+esc(snippet.slice(0,60)) : ''}</div>
        </div>
      </div>`;
  }

  function bindHomeEvents(){
    viewContainer.querySelectorAll('[data-goto]').forEach(el=>{
      el.addEventListener('click', ()=>{ state.prevView = 'home'; setView(el.dataset.goto); });
    });
    viewContainer.querySelectorAll('[data-goto-checklist]').forEach(el=>{
      el.addEventListener('click', ()=> navigateToChecklist(el.dataset.gotoChecklist, 'home'));
    });
    bindCommonListItemEvents();
  }

  function bindCommonListItemEvents(){
    viewContainer.querySelectorAll('[data-play]').forEach(el=>{
      el.addEventListener('click', e=>{ e.stopPropagation(); togglePlay(el.dataset.play); });
    });
    viewContainer.querySelectorAll('[data-detail]').forEach(el=>{
      el.addEventListener('click', ()=> openDetailModal(el.dataset.detail));
    });
    viewContainer.querySelectorAll('[data-toggle-item]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const [clId, itId] = el.dataset.toggleItem.split('|');
        toggleChecklistItem(clId, itId);
      });
    });
    viewContainer.querySelectorAll('[data-toggle-important]').forEach(el=>{
      el.addEventListener('click', e=>{ e.stopPropagation(); toggleImportant(el.dataset.toggleImportant); });
    });
    viewContainer.querySelectorAll('[data-open]').forEach(el=>{
      el.addEventListener('click', ()=> openCreateModal(el.dataset.open));
    });
    viewContainer.querySelectorAll('[data-delete-entry]').forEach(el=>{
      el.addEventListener('click', e=>{ e.stopPropagation(); deleteEntry(el.dataset.deleteEntry); });
    });
    viewContainer.querySelectorAll('[data-edit-entry]').forEach(el=>{
      el.addEventListener('click', e=>{ e.stopPropagation(); openEditEntryModal(el.dataset.editEntry); });
    });
    viewContainer.querySelectorAll('[data-delete-checklist]').forEach(el=>{
      el.addEventListener('click', e=>{ e.stopPropagation(); deleteChecklist(el.dataset.deleteChecklist); });
    });
  }

  /* ---------- ALL NOTES ---------- */
  function renderAllNotes(){
    const q = state.searchQuery;
    const items = allEntries().filter(e=>e.type==='note').filter(e=>matchesEntry(e,q));
    viewContainer.innerHTML = `
      <div class="view-head">
        <button class="back-btn" data-back aria-label="Back">${ICONS.back}</button>
        <div class="view-title">All notes</div>
        <button class="new-btn" data-open="note">${ICONS.plus} New</button>
      </div>
      <div class="list-col">
        ${items.length ? importantFirstHtml(items, noteCardHtml) : `<div class="empty-hint">${esc(q?'No matches found':'No notes yet')}</div>`}
      </div>
    `;
    bindListViewEvents();
  }
  function noteCardHtml(e){
    return `
      <div class="item-card">
        <div class="item-card-head">
          <div class="item-card-title" data-detail="${e.id}">${esc(e.title||'Untitled note')}</div>
          <div class="item-card-time">${fmtTime(e.createdAt)}</div>
          <button class="icon-btn-sm" data-delete-entry="${e.id}" aria-label="Delete">${ICONS.trash}</button>
          <button class="icon-btn-sm star-btn ${e.important?'starred':''}" data-toggle-important="entry|${e.id}" aria-label="${e.important?'Unstar':'Star as important'}">${ICONS.star}</button>
        </div>
        ${e.text ? `<div class="item-card-body">${esc(e.text)}</div>` : ''}
        ${(e.photos&&e.photos.length) ? `<div class="item-photos-row">${e.photos.map(p=>`<div class="mini-thumb" style="background-image:url('${p.dataUrl}')" data-detail="${e.id}"></div>`).join('')}</div>` : ''}
      </div>`;
  }

  /* ---------- ALL VOICE ---------- */
  function renderAllVoice(){
    const q = state.searchQuery;
    const items = allEntries().filter(e=>e.type==='voice').filter(e=>matchesEntry(e,q));
    viewContainer.innerHTML = `
      <div class="view-head">
        <button class="back-btn" data-back aria-label="Back">${ICONS.back}</button>
        <div class="view-title">All voice notes</div>
        <button class="new-btn" data-open="voice">${ICONS.plus} New</button>
      </div>
      <div class="list-col">
        ${items.length ? importantFirstHtml(items, voiceCardHtml) : `<div class="empty-hint">${esc(q?'No matches found':'No voice notes yet')}</div>`}
      </div>
    `;
    bindListViewEvents();
  }
  function voiceCardHtml(e){
    const isPlaying = state.playingId===e.id;
    const ai = e.summarizing
      ? `<div class="ai-loading">Preparing local summary…</div>`
      : (e.summaryLines && e.summaryLines.length
        ? `<div class="ai-summary-label">AI summary</div><ul class="ai-summary-list">${e.summaryLines.map(l=>`<li>${esc(l)}</li>`).join('')}</ul>`
        : (e.transcript ? `<button class="ghost-btn" data-resummarize="${e.id}">Prepare local summary</button>` : ''));
    return `
      <div class="item-card">
        <div class="item-card-head">
          <button class="play-btn" data-play="${e.id}" aria-label="Play">${isPlaying?ICONS.pause:ICONS.play}</button>
          <div class="item-card-title" data-detail="${e.id}">${esc(e.title||'Untitled voice note')}</div>
          <div class="item-card-time">${fmtTime(e.createdAt)}</div>
          <button class="icon-btn-sm" data-delete-entry="${e.id}" aria-label="Delete">${ICONS.trash}</button>
          <button class="icon-btn-sm star-btn ${e.important?'starred':''}" data-toggle-important="entry|${e.id}" aria-label="${e.important?'Unstar':'Star as important'}">${ICONS.star}</button>
        </div>
        ${e.text ? `<div class="item-card-body">${esc(e.text)}</div>` : ''}
        ${ai}
        ${(e.photos&&e.photos.length) ? `<div class="item-photos-row">${e.photos.map(p=>`<div class="mini-thumb" style="background-image:url('${p.dataUrl}')" data-detail="${e.id}"></div>`).join('')}</div>` : ''}
      </div>`;
  }

  /* ---------- ALL VISUAL ---------- */
  function renderAllVisual(){
    const q = state.searchQuery;
    const photos = allPhotosFlat().filter(p => !q || (p.photo.caption||'').toLowerCase().includes(q.toLowerCase()) || matchesEntry(p.entry,q));
    const visualCardHtml = p => `
      <div class="visual-full-item">
        <div class="img" role="img" aria-label="${esc(p.photo.alt||p.photo.caption||p.entry.title||'Saved image')}" style="background-image:url('${p.photo.dataUrl}')" data-detail="${p.entry.id}">
          <button class="icon-btn-sm star-btn ${p.entry.important?'starred':''}" data-toggle-important="entry|${p.entry.id}" aria-label="${p.entry.important?'Unstar':'Star as important'}">${ICONS.star}</button>
        </div>
        <div class="cap" data-detail="${p.entry.id}">${esc(p.photo.caption||'')}</div>
      </div>`;
    viewContainer.innerHTML = `
      <div class="view-head">
        <button class="back-btn" data-back aria-label="Back">${ICONS.back}</button>
        <div class="view-title">Visual feed</div>
        <button class="new-btn" data-open="screenshot">${ICONS.plus} New</button>
      </div>
      <div class="visual-full-grid">
        ${photos.length ? importantFirstHtml(photos, visualCardHtml, p=>!!p.entry.important) : `<div class="empty-hint">${esc(q?'No matches found':'No photos yet')}</div>`}
      </div>
    `;
    bindListViewEvents();
  }

  /* ---------- ALL CHECKLISTS ---------- */
  function renderAllChecklists(){
    const q = state.searchQuery;
    const lists = allChecklists().filter(c=>matchesChecklist(c,q));
    const checklistCardHtml = c => `
          <div class="checklist-card ${state.focusChecklistId===c.id?'is-focused':''}" data-checklist-id="${c.id}">
            <div class="checklist-card-head">
              <h3>${esc(c.title)}</h3>
              <span class="checklist-progress">${c.items.filter(i=>i.checked).length}/${c.items.length}</span>
              <button class="icon-btn-sm" data-delete-checklist="${c.id}" aria-label="Delete checklist">${ICONS.trash}</button>
              <button class="icon-btn-sm star-btn ${c.important?'starred':''}" data-toggle-important="checklist|${c.id}" aria-label="${c.important?'Unstar':'Star as important'}">${ICONS.star}</button>
            </div>
            ${c.items.map(it=>checkRowHtml(c.id,it)).join('')}
          </div>`;
    viewContainer.innerHTML = `
      <div class="view-head">
        <button class="back-btn" data-back aria-label="Back">${ICONS.back}</button>
        <div class="view-title">Action steps</div>
        <button class="new-btn" data-open="checklist">${ICONS.plus} New</button>
      </div>
      <div class="list-col">
        ${lists.length ? importantFirstHtml(lists, checklistCardHtml) : `<div class="empty-hint">${esc(q?'No matches found':'No checklists yet')}</div>`}
      </div>
    `;
    bindListViewEvents();
    if(state.focusChecklistId){
      const focused = viewContainer.querySelector(`[data-checklist-id="${state.focusChecklistId}"]`);
      if(focused){ focused.scrollIntoView({block:'center',behavior:appearance.reducedMotion?'auto':'smooth'}); setTimeout(()=>focused.classList.remove('is-focused'),1800); }
      state.focusChecklistId = null;
    }
  }

  /* ---------- FILES ---------- */
  function renderFiles(){
    const q = state.searchQuery;
    const entries = allEntries().filter(e=>matchesEntry(e,q)).map(e=>({...e,kind:e.type}));
    const checklists = allChecklists().filter(c=>matchesChecklist(c,q)).map(c=>({...c,kind:'checklist'}));
    const items = [...entries, ...checklists].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
    viewContainer.innerHTML = `
      <div class="view-head">
        <button class="back-btn" data-back aria-label="Back">${ICONS.back}</button>
        <div class="view-title">All files</div>
      </div>
      <div class="list-col">
        ${items.length ? items.map(fileRowHtml).join('') : `<div class="empty-hint">${esc(q?'No matches found':'Nothing saved yet')}</div>`}
      </div>
    `;
    bindListViewEvents();
  }
  function fileRowHtml(item){
    const kindLabel = {note:'Note', voice:'Voice', screenshot:'Screenshot', checklist:'Checklist'}[item.kind];
    const snippet = item.kind==='checklist'
      ? `${item.items.filter(i=>i.checked).length}/${item.items.length} steps complete`
      : (item.text || (item.photos&&item.photos[0]&&item.photos[0].caption) || (item.summaryLines&&item.summaryLines[0]) || '');
    const detailAttr = item.kind==='checklist' ? `data-goto-checklist="${item.id}"` : `data-detail="${item.id}"`;
    const starKey = item.kind==='checklist' ? `checklist|${item.id}` : `entry|${item.id}`;
    return `
      <div class="item-card">
        <div class="item-card-head">
          <span class="type-pill">${kindLabel}</span>
          <div class="item-card-title" ${detailAttr}>${esc(item.title||'Untitled')}</div>
          <div class="item-card-time">${fmtTime(item.createdAt)}</div>
          ${item.kind==='checklist' ? `<button class="icon-btn-sm" data-delete-checklist="${item.id}" aria-label="Delete">${ICONS.trash}</button>` : `<button class="icon-btn-sm" data-delete-entry="${item.id}" aria-label="Delete">${ICONS.trash}</button>`}
          <button class="icon-btn-sm star-btn ${item.important?'starred':''}" data-toggle-important="${starKey}" aria-label="${item.important?'Unstar':'Star as important'}">${ICONS.star}</button>
        </div>
        ${snippet ? `<div class="item-card-body">${esc(snippet.slice(0,140))}</div>` : ''}
      </div>`;
  }

  /* ---------- IMPORTANT ---------- */
  function renderImportant(){
    const q = state.searchQuery;
    const entries = allEntries().filter(e=>e.important).filter(e=>matchesEntry(e,q)).map(e=>({...e,kind:e.type}));
    const checklists = allChecklists().filter(c=>c.important).filter(c=>matchesChecklist(c,q)).map(c=>({...c,kind:'checklist'}));
    const items = [...entries, ...checklists].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
    viewContainer.innerHTML = `
      <div class="view-head">
        <button class="back-btn" data-back aria-label="Back">${ICONS.back}</button>
        <div class="view-title">Important</div>
      </div>
      <div class="list-col">
        ${items.length ? items.map(fileRowHtml).join('') : `<div class="empty-hint">${esc(q?'No matches found':'Nothing flagged as important yet — hover any item in a library and tap the star')}</div>`}
      </div>
    `;
    bindListViewEvents();
  }

  /* ---------- SEARCH ---------- */
  function renderSearch(){
    const q = state.searchQuery;
    const entries = allEntries().map(e=>({...e,kind:e.type,_searchScore:searchScoreEntry(e,q)})).filter(e=>e._searchScore>0);
    const checklists = allChecklists().map(c=>({...c,kind:'checklist',_searchScore:searchScoreChecklist(c,q)})).filter(c=>c._searchScore>0);
    const items = [...entries, ...checklists].sort((a,b)=> b._searchScore-a._searchScore || new Date(b.createdAt)-new Date(a.createdAt));
    viewContainer.innerHTML = `
      <div class="view-head">
        <button class="back-btn" data-back aria-label="Back">${ICONS.back}</button>
        <div class="view-title">Results for "${esc(q)}"</div>
      </div>
      <div class="list-col">
        ${items.length ? items.map(fileRowHtml).join('') : `<div class="empty-hint">Nothing in your mind matches that yet</div>`}
      </div>
    `;
    bindListViewEvents();
  }

  function bindListViewEvents(){
    bindCommonListItemEvents();
    const back = viewContainer.querySelector('[data-back]');
    if(back) back.addEventListener('click', ()=>{
      $('#search-input').value='';
      state.searchQuery='';
      setView(state.prevView && state.prevView!=='search' ? state.prevView : 'home');
    });
    viewContainer.querySelectorAll('[data-goto-checklist]').forEach(el=>{
      el.addEventListener('click', ()=> navigateToChecklist(el.dataset.gotoChecklist, state.view));
    });
    viewContainer.querySelectorAll('[data-resummarize]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const it = findEntry(el.dataset.resummarize);
        if(it) generateVoiceSummary(it);
      });
    });
  }

  function navigateToChecklist(checklistId, fromView){
    state.prevView = fromView || state.view;
    state.focusChecklistId = checklistId;
    state.searchQuery='';
    if($('#search-input')) $('#search-input').value='';
    closeModal();
    setView('all-checklists');
  }

  /* ---------- SETTINGS ---------- */
  function renderSettings(){
    viewContainer.innerHTML = `
      <div class="settings-title">Settings</div>
      <div class="settings-sub">Make this space feel like yours.</div>

      <div class="settings-section">
        <div class="settings-section-title">Theme presets</div>
        <div class="mode-toggle-row" id="mode-toggle-row"></div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Accent colors</div>
        <div class="accent-grid" id="accent-grid"></div>
        <div class="custom-accent-row">
          <input type="color" class="color-picker-input" id="custom-accent-input" value="${appearance.customColor || '#ff2a1f'}" aria-label="Custom accent color">
          <div>
            <div class="settings-row-label" style="font-size:var(--text-sm);">Custom color</div>
            <div class="settings-row-desc">Pick your own accent — everything else stays minimal</div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Display</div>
        <div class="settings-list">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Tinted background</div>
              <div class="settings-row-desc">Wash the background in your accent color — tip: click the logo to toggle this anytime</div>
            </div>
            <button class="toggle ${appearance.tinted?'on':''}" id="invert-toggle" role="switch" aria-checked="${appearance.tinted}" aria-label="Toggle tinted background"></button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Accessibility</div>
        <div class="settings-list">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Reduced motion</div>
              <div class="settings-row-desc">Minimize interface animation</div>
            </div>
            <button class="toggle ${appearance.reducedMotion?'on':''}" id="motion-toggle" role="switch" aria-checked="${appearance.reducedMotion}" aria-label="Toggle reduced motion"></button>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-row-label">High contrast</div>
              <div class="settings-row-desc">Increase border and text contrast</div>
            </div>
            <button class="toggle ${appearance.highContrast?'on':''}" id="contrast-toggle" role="switch" aria-checked="${appearance.highContrast}" aria-label="Toggle high contrast"></button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Prototype mode</div>
        <div class="prototype-status">
          <span class="prototype-dot" aria-hidden="true"></span>
          <div class="prototype-copy">
            <strong>Local demo dataset</strong>
            <span>No cloud connection required</span>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Demo controls</div>
        <div class="demo-actions">
          <button class="ghost-btn danger-btn" id="reset-demo-library">${ICONS.reset} Reset demo library</button>
          <button class="ghost-btn" id="restore-samples">Restore sample memories</button>
          <button class="ghost-btn" id="clear-user-memories">Clear user-created memories</button>
        </div>
        <div class="settings-row-desc" style="margin-top:var(--sp-3);">Reset restores sample content and checklist state while keeping your current theme.</div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Advanced</div>
        <div class="settings-list">
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Storage</div>
              <div class="settings-row-desc">Notes, voice recordings and screenshots saved on this device</div>
            </div>
            <div class="settings-row-value">${state.data.entries.length + state.data.checklists.length} items</div>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-row-label">AI summaries</div>
              <div class="settings-row-desc">Automatically summarize voice notes and screenshots</div>
            </div>
            <button class="toggle ${state.appSettings.aiSummaries?'on':''}" id="ai-toggle" role="switch" aria-checked="${state.appSettings.aiSummaries}" aria-label="Toggle automatic local summaries"></button>
          </div>
        </div>
      </div>
    `;
    renderModeToggle();
    renderAccentGrid();
    $('#invert-toggle').addEventListener('click', ()=>{ appearance.tinted = !appearance.tinted; applyAppearance(true); });
    $('#motion-toggle').addEventListener('click', ()=>{ appearance.reducedMotion = !appearance.reducedMotion; applyAppearance(true); });
    $('#contrast-toggle').addEventListener('click', ()=>{ appearance.highContrast = !appearance.highContrast; applyAppearance(true); });
    $('#ai-toggle').addEventListener('click', async e=>{
      state.appSettings.aiSummaries = !state.appSettings.aiSummaries;
      e.currentTarget.classList.toggle('on', state.appSettings.aiSummaries);
      e.currentTarget.setAttribute('aria-checked', String(state.appSettings.aiSummaries));
      await saveAppSettings();
    });
    $('#reset-demo-library').addEventListener('click', resetDemoLibrary);
    $('#restore-samples').addEventListener('click', restoreSampleMemories);
    $('#clear-user-memories').addEventListener('click', clearUserCreatedMemories);
    $('#custom-accent-input').addEventListener('input', e=>{
      appearance.accentId = 'custom';
      appearance.customColor = e.target.value;
      applyAppearance(true);
    });
  }
  function renderModeToggle(){
    const row = $('#mode-toggle-row');
    if(!row) return;
    row.innerHTML = `
      <button class="mode-btn ${appearance.mode==='dark'?'active':''}" data-mode="dark">Dark</button>
      <button class="mode-btn ${appearance.mode==='light'?'active':''}" data-mode="light">Light</button>
    `;
    row.querySelectorAll('[data-mode]').forEach(btn=>{
      btn.addEventListener('click', ()=>{ appearance.mode = btn.dataset.mode; applyAppearance(true); });
    });
  }
  function renderAccentGrid(){
    const grid = $('#accent-grid');
    if(!grid) return;
    grid.innerHTML = ACCENTS.map(a => `
      <div class="accent-swatch ${appearance.accentId===a.id?'active':''}" data-accent="${a.id}">
        <div class="accent-dot" style="background:${a.accent};"></div>
        <div class="accent-swatch-name">${esc(a.name)}</div>
      </div>
    `).join('');
    grid.querySelectorAll('[data-accent]').forEach(el=>{
      el.addEventListener('click', ()=>{ appearance.accentId = el.dataset.accent; applyAppearance(true); });
    });
  }

  /* ============ AUDIO PLAYBACK ============ */
  function stopPlayback(){
    if(state.currentAudio){
      try{ state.currentAudio.pause(); state.currentAudio.currentTime = 0; }catch(_error){ /* already stopped */ }
      state.currentAudio = null;
    }
    if('speechSynthesis' in window){
      try{ window.speechSynthesis.cancel(); }catch(_error){ /* unavailable voice engine */ }
    }
    state.currentUtterance = null;
    state.playingId = null;
  }

  function speakEntry(entry){
    const text = entry.audioText || entry.transcript || entry.text || '';
    if(!text || !('speechSynthesis' in window)){
      stopPlayback();
      showToast('No playable audio or transcript for this note');
      render();
      return;
    }
    try{
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.98;
      utterance.onend = utterance.onerror = ()=>{ if(state.currentUtterance===utterance){ stopPlayback(); render(); } };
      state.currentUtterance = utterance;
      state.playingId = entry.id;
      window.speechSynthesis.speak(utterance);
      render();
    }catch(_error){
      stopPlayback();
      showToast('Speech playback is unavailable in this browser');
      render();
    }
  }

  function togglePlay(id){
    const entry = findEntry(id);
    if(!entry) return;
    if(state.playingId===id){ stopPlayback(); render(); return; }
    stopPlayback();
    if(!entry.audio){ speakEntry(entry); return; }
    const audio = new Audio(entry.audio);
    state.currentAudio = audio;
    state.playingId = id;
    audio.onended = ()=>{ stopPlayback(); render(); };
    audio.onerror = ()=>{ state.currentAudio=null; speakEntry(entry); };
    const playAttempt = audio.play();
    if(playAttempt && typeof playAttempt.catch==='function') playAttempt.catch(()=>{ state.currentAudio=null; speakEntry(entry); });
    render();
  }

  /* ============ CHECKLIST MUTATIONS ============ */
  async function toggleChecklistItem(checklistId, itemId){
    const c = findChecklist(checklistId);
    if(!c) return;
    const item = c.items.find(i=>i.id===itemId);
    if(!item) return;
    item.checked = !item.checked;
    render();
    await saveData();
  }
  async function toggleImportant(key){
    const [kind, id] = key.split('|');
    const item = kind==='checklist' ? findChecklist(id) : findEntry(id);
    if(!item) return;
    item.important = !item.important;
    render();
    await saveData();
  }
  async function deleteEntry(id){
    if(state.playingId===id) stopPlayback();
    state.data.entries = state.data.entries.filter(e=>e.id!==id);
    await saveData();
    closeModal();
    render();
  }
  async function deleteChecklist(id){
    state.data.checklists = state.data.checklists.filter(c=>c.id!==id);
    await saveData();
    closeModal();
    render();
  }

  /* ============ DETAIL MODAL ============ */
  function openDetailModal(entryId){
    const e = findEntry(entryId);
    if(!e) return;
    const kindLabel = {note:'Note', voice:'Voice note', screenshot:'Screenshot'}[e.type];
    const aiBlock = e.summarizing
      ? `<div class="ai-loading">Preparing local summary…</div>`
      : (e.summaryLines && e.summaryLines.length
        ? `<div class="ai-summary-label">AI summary</div><ul class="ai-summary-list">${e.summaryLines.map(l=>`<li>${esc(l)}</li>`).join('')}</ul>`
        : (e.transcript ? `<button class="ghost-btn" data-resummarize="${e.id}">Prepare local summary</button>` : ''));
    modalRoot.innerHTML = `
      <div class="modal-overlay" data-overlay-close role="dialog" aria-modal="true">
        <div class="modal-box">
          <div class="modal-head"><h3>${kindLabel}</h3><button class="modal-close" data-close aria-label="Close">${ICONS.close}</button></div>
          ${e.photos && e.photos.length ? e.photos.map(p=>`
            <img class="lightbox-img" src="${p.dataUrl}" alt="${esc(p.alt||p.caption||e.title||'Saved image')}">
            <div class="item-modal-detail" style="margin-bottom:12px;color:var(--text-muted);font-style:italic;">${esc(p.caption||'')}</div>
          `).join('') : ''}
          ${e.audio ? `<audio class="audio-preview" controls src="${e.audio}"></audio>` : ''}
          ${e.type==='voice' ? `<button class="ghost-btn" data-play-detail="${e.id}">${state.playingId===e.id?ICONS.pause+' Pause':ICONS.play+' Play voice note'}</button>` : ''}
          <div style="margin-top:10px;">
            <div class="field-label">${esc(e.title||'Untitled')}</div>
            <div class="item-modal-detail">${esc(e.text||'')}</div>
            ${e.transcript ? `<div class="detail-transcript"><div class="field-label">Transcript</div><div class="item-modal-detail">${esc(e.transcript)}</div></div>` : ''}
            ${aiBlock}
            <div class="voice-time" style="margin-top:10px;">${fmtTime(e.createdAt)}</div>
          </div>
          <div class="modal-actions">
            <button class="ghost-btn" data-edit-entry="${e.id}">${ICONS.edit} Edit</button>
            <button class="ghost-btn" data-delete-entry="${e.id}">${ICONS.trash} Delete</button>
          </div>
        </div>
      </div>
    `;
    bindModalCommon();
    modalRoot.querySelector('[data-delete-entry]').addEventListener('click', ()=>deleteEntry(e.id));
    modalRoot.querySelector('[data-edit-entry]').addEventListener('click', ()=>openEditEntryModal(e.id));
    const playDetail = modalRoot.querySelector('[data-play-detail]');
    if(playDetail) playDetail.addEventListener('click', ()=>{ togglePlay(e.id); openDetailModal(e.id); });
    const rs = modalRoot.querySelector('[data-resummarize]');
    if(rs) rs.addEventListener('click', ()=> generateVoiceSummary(e));
  }

  function bindModalCommon(){
    modalRoot.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click', closeModal));
    const overlay = modalRoot.querySelector('[data-overlay-close]');
    if(overlay) overlay.addEventListener('click', e=>{ if(e.target===overlay) closeModal(); });
  }
  function closeModal(){
    const hadPlayback=!!state.playingId;
    stopAnyMediaStreams();
    stopPlayback();
    modalRoot.innerHTML='';
    state.modal=null;
    state.draft={};
    if(hadPlayback) render();
  }
  function stopAnyMediaStreams(){
    if(recognizer){ try{ recognizer.stop(); }catch(_error){} recognizer=null; }
    if(mediaRecorder && mediaRecorder.state!=='inactive'){ try{ mediaRecorder.stop(); }catch(_error){} }
    if(state.draft.recordingStream){ state.draft.recordingStream.getTracks().forEach(t=>t.stop()); }
    if(state.draft.recTimerHandle) clearInterval(state.draft.recTimerHandle);
    state.draft.recording = false;
  }

  /* ============ EDIT ENTRY MODAL ============ */
  function openEditEntryModal(entryId){
    const e = findEntry(entryId);
    if(!e) return;
    state.modal = 'edit-entry';
    state.draft = {
      id: e.id,
      type: e.type,
      title: e.title || '',
      text: e.text || '',
      audioDataUrl: e.audio || null,
      transcript: e.transcript || '',
      photos: (e.photos||[]).map(p=>({ id:p.id, dataUrl:p.dataUrl, caption:p.caption||'', alt:p.alt||'' })),
      recording:false,
    };
    renderEditEntryModal();
  }

  function renderEditEntryModal(){
    const d = state.draft;
    const kindLabel = {note:'note', voice:'voice note', screenshot:'screenshot'}[d.type] || 'entry';
    const hasAudioSection = d.type==='voice' || d.type==='screenshot';
    modalRoot.innerHTML = `
      <div class="modal-overlay" data-overlay-close role="dialog" aria-modal="true">
        <div class="modal-box">
          <div class="modal-head"><h3>Edit ${kindLabel}</h3><button class="modal-close" data-close aria-label="Close">${ICONS.close}</button></div>
          <div class="field"><label class="field-label">Title</label><input class="text-input" id="edit-title" placeholder="Give it a name..." value="${esc(d.title)}"></div>
          ${hasAudioSection ? `
          <div class="field">
            <label class="field-label">Audio</label>
            ${d.audioDataUrl ? `<audio class="audio-preview" controls src="${d.audioDataUrl}"></audio>` : `<div class="voice-time" style="font-style:italic;">No audio attached</div>`}
            <div class="row-flex" style="margin-top:8px;">
              <button class="ghost-btn ${d.recording?'rec-active':''}" id="edit-rec-toggle">
                ${d.recording ? ICONS.stop+' Stop' : (d.audioDataUrl ? ICONS.mic+' Re-record' : ICONS.mic+' Record')}
              </button>
              ${d.recording ? `<span class="rec-timer" id="edit-rec-timer">0:00</span>` : ''}
              ${(d.audioDataUrl && !d.recording) ? `<button class="ghost-btn" id="edit-delete-audio">${ICONS.trash} Delete audio</button>` : ''}
            </div>
          </div>` : ''}
          <div class="field"><label class="field-label">Notes</label><textarea class="text-area" id="edit-text" placeholder="Write what's on your mind...">${esc(d.text)}</textarea></div>
          ${d.type==='voice'?`<div class="field"><label class="field-label">Transcript</label><textarea class="text-area manual-transcript" id="edit-transcript" placeholder="Add a manual transcript…">${esc(d.transcript||'')}</textarea></div>`:''}
          <div class="field">
            <label class="field-label">Photos</label>
            <button class="ghost-btn" id="edit-add-photo">${ICONS.image} Add photo</button>
            <input type="file" accept="image/*" id="edit-photo-input" style="display:none">
            ${photoStripHtml()}
          </div>
          <div class="modal-actions">
            <button class="ghost-btn" data-close>Cancel</button>
            <button class="primary-btn" id="edit-save" ${anyPhotoAnalyzing()?'disabled':''}>Save changes</button>
          </div>
        </div>
      </div>
    `;
    bindModalCommon();
    bindPhotoStripEvents(renderEditEntryModal);
    $('#edit-title').addEventListener('input', e=>{ d.title = e.target.value; });
    $('#edit-text').addEventListener('input', e=>{ d.text = e.target.value; });
    const editTranscript=$('#edit-transcript');
    if(editTranscript) editTranscript.addEventListener('input', e=>{ d.transcript=e.target.value; });
    $('#edit-add-photo').addEventListener('click', ()=> $('#edit-photo-input').click());
    $('#edit-photo-input').addEventListener('change', ev=>{
      d.title = $('#edit-title').value; d.text = $('#edit-text').value;
      if(ev.target.files[0]) addPhotoFromFile(ev.target.files[0], renderEditEntryModal);
    });
    if(hasAudioSection){
      if(d.recording){
        let seconds = d.recSeconds||0;
        d.recTimerHandle = setInterval(()=>{
          seconds++; d.recSeconds=seconds;
          const el = $('#edit-rec-timer');
          if(el) el.textContent = Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
        },1000);
      }
      $('#edit-rec-toggle').addEventListener('click', async ()=>{
        d.title = $('#edit-title').value; d.text = $('#edit-text').value;
        if(!d.recording){
          const ok = await startRecording();
          if(!ok){ showToast('Microphone access denied or unavailable'); return; }
          d.recording = true; d.recSeconds = 0;
          renderEditEntryModal();
        } else {
          if(d.recTimerHandle) clearInterval(d.recTimerHandle);
          const dataUrl = await stopRecording();
          d.recording = false;
          d.audioDataUrl = dataUrl;
          if(d.type==='voice') d.transcript = liveTranscript.trim() || d.transcript || '';
          renderEditEntryModal();
        }
      });
      const delAudioBtn = $('#edit-delete-audio');
      if(delAudioBtn) delAudioBtn.addEventListener('click', ()=>{
        d.audioDataUrl = null;
        if(d.type==='voice') d.transcript = '';
        renderEditEntryModal();
      });
    }
    $('#edit-save').addEventListener('click', async ()=>{
      const title = $('#edit-title').value.trim();
      const text = $('#edit-text').value.trim();
      const entry = findEntry(d.id);
      if(!entry){ closeModal(); return; }
      entry.title = title || entry.title || 'Untitled';
      entry.text = text;
      entry.audio = d.audioDataUrl || null;
      if(d.type==='voice'){
        entry.transcript = ($('#edit-transcript')?.value || d.transcript || '').trim();
        entry.audioText = entry.audioText || entry.transcript;
      }
      entry.photos = d.photos.map(p=>({ id:p.id, dataUrl:p.dataUrl, caption:p.caption, alt:p.alt||p.caption||entry.title }));
      const ok = await saveData();
      if(!ok) showToast('Saved for this session (storage limit reached)');
      closeModal();
      render();
    });
  }

  /* ============ CREATE MODALS ============ */
  function openCreateModal(type){
    if(type==='ask'){ openAskModal(); return; }
    state.modal = type;
    state.draft = { photos: [], id: uid() };
    if(type==='note') renderNoteModal();
    if(type==='voice') renderVoiceModal();
    if(type==='screenshot') renderScreenshotModal();
    if(type==='checklist') renderChecklistModal();
  }

  function photoStripHtml(){
    return `<div class="photo-strip">${state.draft.photos.map(p=>`
      <div class="photo-chip" style="background-image:url('${p.dataUrl}')">
        ${p.analyzing ? `<div class="cap-status"><div class="spinner"></div></div>` : ''}
        <div class="rm" data-remove-photo="${p.id}">${ICONS.close}</div>
      </div>`).join('')}</div>`;
  }
  function anyPhotoAnalyzing(){ return state.draft.photos.some(p=>p.analyzing); }
  function bindPhotoStripEvents(rerender){
    modalRoot.querySelectorAll('[data-remove-photo]').forEach(el=>{
      el.addEventListener('click', ()=>{
        state.draft.photos = state.draft.photos.filter(p=>p.id!==el.dataset.removePhoto);
        rerender();
      });
    });
  }
  function addPhotoFromFile(file, rerender){
    const reader = new FileReader();
    reader.onload = async ()=>{
      const photo = { id: uid(), dataUrl: reader.result, alt:file.name?`Uploaded image: ${file.name}`:'Uploaded image', caption:'', analyzing:true };
      state.draft.photos.push(photo);
      rerender();
      const caption = await generateCaption(reader.result);
      photo.caption = caption;
      photo.analyzing = false;
      rerender();
    };
    reader.readAsDataURL(file);
  }

  /* ============ LOCAL IMAGE & VOICE FALLBACKS ============ */
  async function generateCaption(){
    await delayForDemo(appearance.reducedMotion ? 0 : APP_CONFIG.simulatedAnalysisDelay);
    return 'Uploaded image saved for later recall.';
  }

  async function summarizeTranscript(transcript){
    const clean = String(transcript||'').trim();
    if(!clean) return ['Recording saved. Add a transcript for searchable recall.'];
    const sentences = clean.split(/(?<=[.!?])\s+/).map(line=>line.trim()).filter(Boolean);
    return sentences.slice(0,3).map(line=>line.length>110 ? line.slice(0,107)+'…' : line);
  }

  async function generateVoiceSummary(entry){
    entry.summarizing = true;
    render();
    entry.summaryLines = await summarizeTranscript(entry.transcript);
    entry.summarizing = false;
    await saveData();
    render();
  }

  /* ============ DETERMINISTIC LOCAL RECALL ============ */
  function findByDemoKey(key){
    return state.data.entries.find(item=>item.demoKey===key) || state.data.checklists.find(item=>item.demoKey===key) || null;
  }

  function formatNaturalList(items){
    if(items.length===0) return '';
    if(items.length===1) return items[0];
    if(items.length===2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0,-1).join(', ')}, and ${items[items.length-1]}`;
  }

  const DEMO_INTENTS = [
    {
      id:'shoe-price', sourceKeys:['shoes','trail-shoes','white-sneakers'],
      phrases:['what was the price of the shoes','how much were those running shoes','shoe price','price of my shoes'],
      keywords:['price','cost','how much','shoe','running'], synonyms:['trainers','sneakers'],
      requiredAny:['shoe','running','trainer','sneaker'],
      answerBuilder(_source,sources){ return { answer:`Your saved shoe prices were ${formatNaturalList(sources.map(source=>`${source.metadata.product} at ${source.metadata.price}`))}.`, matchedFacts:sources.flatMap(source=>[source.metadata.product,source.metadata.price]) }; }
    },
    {
      id:'shoe-size', sourceKeys:['shoes','trail-shoes','white-sneakers'],
      phrases:['what size did i select','what size were the shoes','selected shoe size','which size did i choose'],
      keywords:['size','selected','choose','shoe'], synonyms:['fit'],
      answerBuilder(_source,sources){ const sizes=[...new Set(sources.map(source=>source.metadata.selectedSize))]; return { answer:sizes.length===1 ? `You selected ${sizes[0]} for all three saved shoe options.` : `Your saved shoe sizes were ${formatNaturalList(sizes)}.`, matchedFacts:sizes }; }
    },
    {
      id:'shoe-recall', sourceKeys:['shoes','trail-shoes','white-sneakers'],
      phrases:['which shoes did i like','show me the shoes i saved','which running shoes did i save','show me my shoe options'],
      keywords:['shoe','running','liked','saved','option'], synonyms:['trainers','sneakers','footwear'],
      answerBuilder(_source,sources){
        const lines=sources.map(source=>source.recallLine).filter(Boolean);
        return { answer:`You saved three distinct options. ${lines.join(' ')}`, matchedFacts:sources.flatMap(source=>[source.metadata.product,source.metadata.price,source.metadata.selectedSize]) };
      }
    },
    {
      id:'client-request', sourceKeys:['client-call'],
      phrases:['what did the client ask me to change','what did the client request','client dashboard changes','client redesign request'],
      keywords:['client','dashboard','change','redesign','request','pdf','dark theme'], synonyms:['call requirements','card alignment'],
      answerBuilder(source){ const m=source.metadata; return { answer:`The client asked you to preserve the dark theme, improve card alignment, and add PDF export. The redesign is due ${m.dueLabel}, and the budget is fixed.`, matchedFacts:[m.theme,...m.changes,m.dueLabel,m.budget] }; }
    },
    {
      id:'goa-saved', sourceKeys:['goa-trip','camera-kit'],
      phrases:['what did i save for goa','what have i saved for goa','show everything for goa','goa memories'],
      keywords:['goa','saved','camera','pack'], synonyms:['goa plans','goa memory'],
      answerBuilder(_source,sources){
        const trip=sources.find(source=>source.demoKey==='goa-trip');
        const camera=sources.find(source=>source.demoKey==='camera-kit');
        return { answer:`For Goa, your flights are booked for ${trip.metadata.dates} at ${trip.metadata.fare}. For the sunrise walk, you planned to pack the ${camera.metadata.kit.join(', ').toLowerCase()}. You still need to shortlist three beach stays under ₹7,000 per night.`, matchedFacts:[trip.metadata.dates,trip.metadata.fare,...camera.metadata.kit] };
      }
    },
    {
      id:'goa-trip', sourceKeys:['goa-trip'],
      phrases:['when is my goa trip','goa flight dates','when are my goa flights','show my goa itinerary'],
      keywords:['goa','trip','flight','date','december','itinerary'], synonyms:['holiday','travel'],
      requiredAny:['goa','flight','itinerary'],
      answerBuilder(source){ const m=source.metadata; return { answer:`Your Goa trip is scheduled for ${m.dates}. The return flight is booked for ${m.fare}.`, matchedFacts:[m.destination,m.dates,m.fare] }; }
    },
    {
      id:'hackathon-open', sourceKeys:['hackathon'],
      phrases:['what is still left for the hackathon','what is left for the hackathon','hackathon tasks remaining','things left to submit','what is left to submit'],
      keywords:['hackathon','submission','submit','remaining','left','task','still open'], synonyms:['competition checklist','unfinished'],
      answerBuilder(source){ const open=source.items.filter(item=>!item.checked).map(item=>item.text); return { answer:open.length ? `You still need to ${formatNaturalList(open.map(item=>item.charAt(0).toLowerCase()+item.slice(1)))}.` : 'Everything on your hackathon checklist is complete.', matchedFacts:open }; }
    },
    {
      id:'groceries-open', sourceKeys:['groceries'],
      phrases:['what groceries do i still need','what groceries are left','what do i need to buy','grocery items remaining'],
      keywords:['grocery','groceries','shopping','buy','food','still need'], synonyms:['shopping list'],
      answerBuilder(source){ const open=source.items.filter(item=>!item.checked).map(item=>item.text); return { answer:open.length ? `You still need ${formatNaturalList(open)}.` : 'Everything on your grocery checklist is complete.', matchedFacts:open }; }
    },
    {
      id:'pitch-structure', sourceKeys:['project-idea'],
      phrases:['how should i structure the pitch','how do i structure the pitch','pitch structure','how should the demo flow'],
      keywords:['pitch','structure','presentation','demo','information overload'], synonyms:['talk','narrative'],
      answerBuilder(source){ return { answer:'Start with the information-overload problem, demonstrate capture, then ask a natural-language question and reveal the original source.', matchedFacts:source.metadata.structure||[] }; }
    }
  ];

  function intentScore(intent, normalizedQuestion){
    let score = 0;
    intent.phrases.forEach(phrase=>{
      const normalizedPhrase = normalizeText(phrase);
      if(normalizedQuestion.includes(normalizedPhrase)) score += 12 + normalizedPhrase.split(' ').length;
    });
    const questionTokens = new Set(normalizedQuestion.split(' ').map(singularToken));
    [...intent.keywords,...(intent.synonyms||[])].forEach(term=>{
      const normalizedTerm = normalizeText(term);
      if(normalizedTerm.includes(' ')){
        if(normalizedQuestion.includes(normalizedTerm)) score += 4;
      }else if(questionTokens.has(singularToken(normalizedTerm))) score += 2;
    });
    return score;
  }

  const RECALL_STOP_WORDS = new Set(['a','about','all','an','and','are','can','did','do','for','from','have','i','in','is','it','me','memory','memories','my','of','one','ones','please','save','saved','show','something','tell','that','the','these','this','those','to','was','were','what','which','with','you']);

  function allSavedMemories(){ return [...state.data.entries,...state.data.checklists]; }

  function recallQueryTokens(question){
    return [...new Set(normalizeText(question).split(' ').map(singularToken).filter(token=>token.length>1&&!RECALL_STOP_WORDS.has(token)))];
  }

  function recallScoreMemory(memory, question){
    const tokens=recallQueryTokens(question);
    if(!tokens.length) return 0;
    const title=normalizeText(memory.title);
    const tagText=normalizeText([...(memory.tags||[]),...(memory.synonyms||[])].join(' '));
    const documentText=normalizeText(Array.isArray(memory.items)?searchDocumentForChecklist(memory):searchDocumentForEntry(memory));
    const titleTokens=new Set(title.split(' ').map(singularToken));
    const tagTokens=new Set(tagText.split(' ').map(singularToken));
    const documentTokens=new Set(documentText.split(' ').map(singularToken));
    let score=0;
    tokens.forEach(token=>{
      if(tagTokens.has(token)) score+=8;
      if(titleTokens.has(token)) score+=6;
      if(documentTokens.has(token)) score+=3;
      else if(token.length>3 && documentText.includes(token)) score+=1;
    });
    const meaningfulPhrase=tokens.join(' ');
    if(tokens.length>1 && (title.includes(meaningfulPhrase)||tagText.includes(meaningfulPhrase))) score+=8;
    return score;
  }

  function rankRelevantMemories(question, limit=4){
    return allSavedMemories()
      .map(memory=>({memory,score:recallScoreMemory(memory,question)}))
      .filter(row=>row.score>=3)
      .sort((a,b)=>b.score-a.score || Number(!!b.memory.important)-Number(!!a.memory.important) || new Date(b.memory.createdAt)-new Date(a.memory.createdAt))
      .slice(0,limit)
      .map(row=>row.memory);
  }

  function recallLineFor(memory){
    if(memory.recallLine) return memory.recallLine;
    if(Array.isArray(memory.items)){
      const open=memory.items.filter(item=>!item.checked).map(item=>item.text);
      return open.length ? `${memory.title}: ${open.length} open — ${formatNaturalList(open.slice(0,3))}.` : `${memory.title} is complete.`;
    }
    if(memory.type==='voice' && memory.summaryLines&&memory.summaryLines.length) return `${memory.title}: ${memory.summaryLines.slice(0,2).join('; ')}.`;
    if(memory.text) return `${memory.title}: ${memory.text}`;
    return `${memory.title} was saved.`;
  }

  function keywordRecallResult(question, sources){
    if(!sources.length) return null;
    const intro=sources.length===1 ? 'I found one matching memory.' : `I found ${sources.length} related memories.`;
    const details=sources.map(recallLineFor).join(' ');
    const fullAnswer=`${intro} ${details}`;
    const primary=sources[0];
    const isChecklist=Array.isArray(primary.items);
    return {
      answer:fullAnswer.length>700?fullAnswer.slice(0,697)+'…':fullAnswer,
      sources,
      entry:isChecklist?null:primary,
      checklist:isChecklist?primary:null,
      primarySourceId:primary.id,
      sourceIds:sources.map(source=>source.id),
      confidence:Math.min(.92,.62+sources.length*.06),
      matchedFacts:sources.map(source=>source.title),
      suggestedAction:null,
      intentId:'keyword-recall'
    };
  }

  function resolveLocalQuestion(question){
    const normalized = normalizeText(question);
    if(!normalized) return null;
    const normalizedTokens=new Set(normalized.split(' ').map(singularToken));
    const ranked = DEMO_INTENTS.map(intent=>({intent,score:intentScore(intent,normalized)}))
      .filter(row=>row.score>=4 && (!row.intent.requiredAny || row.intent.requiredAny.some(term=>normalizedTokens.has(singularToken(normalizeText(term))))) && row.intent.sourceKeys.some(key=>!!findByDemoKey(key)))
      .sort((a,b)=>b.score-a.score || DEMO_INTENTS.indexOf(a.intent)-DEMO_INTENTS.indexOf(b.intent));
    if(ranked.length){
      const best = ranked[0];
      const sources=best.intent.sourceKeys.map(findByDemoKey).filter(Boolean);
      const source=sources[0];
      const built = best.intent.answerBuilder(source,sources);
      const isChecklist = Array.isArray(source.items);
      return {
        answer:built.answer,
        sources,
        entry:isChecklist?null:source,
        checklist:isChecklist?source:null,
        primarySourceId:source.id,
        sourceIds:sources.map(item=>item.id),
        confidence:Math.min(.99,.55+best.score*.025),
        matchedFacts:built.matchedFacts||[],
        suggestedAction:null,
        intentId:best.intent.id
      };
    }
    return keywordRecallResult(question,rankRelevantMemories(question));
  }

  function suggestionTopic(memory){
    const tags=(memory.tags||[]).map(normalizeText);
    if(tags.some(tag=>tag.includes('shoe')||tag.includes('sneaker'))) return 'shoes';
    if(tags.includes('goa')) return 'goa';
    return tags[0] || memory.demoKey || memory.id;
  }

  function buildSavedQuestionSuggestions(limit=6){
    const ordered=allSavedMemories().slice().sort((a,b)=>Number(!b.demoKey)-Number(!a.demoKey) || Number(!!b.important)-Number(!!a.important) || new Date(b.createdAt)-new Date(a.createdAt));
    const candidates=[];
    const seenQuestions=new Set();
    ordered.forEach(memory=>{
      const title=String(memory.title||'this memory').trim();
      const fallbackQuestion=Array.isArray(memory.items) ? `What is left for ${title}?` : memory.type==='voice' ? `What did I say in ${title}?` : memory.type==='screenshot' ? `What did I save in ${title}?` : `What did I note about ${title}?`;
      const questions=(memory.questionSeeds&&memory.questionSeeds.length?memory.questionSeeds:[fallbackQuestion]).filter(Boolean);
      questions.forEach(question=>{
        const key=normalizeText(question);
        if(seenQuestions.has(key)) return;
        seenQuestions.add(key);
        candidates.push({question,sourceTitle:memory.title,topic:suggestionTopic(memory)});
      });
    });
    const picked=[];
    const topics=new Set();
    candidates.forEach(candidate=>{
      if(picked.length>=limit || topics.has(candidate.topic)) return;
      topics.add(candidate.topic); picked.push(candidate);
    });
    candidates.forEach(candidate=>{
      if(picked.length>=limit || picked.some(item=>item.question===candidate.question)) return;
      picked.push(candidate);
    });
    return picked.slice(0,limit);
  }

  function savedMemoriesForNetwork(){
    return [
      ...state.data.entries.map(entry=>({ id:entry.id,type:entry.type,title:entry.title,text:entry.text||'',transcript:entry.transcript||'',imageCaptions:(entry.photos||[]).map(photo=>photo.caption),metadata:entry.metadata||{} })),
      ...state.data.checklists.map(checklist=>({ id:checklist.id,type:'checklist',title:checklist.title,items:checklist.items.map(item=>({text:item.text,checked:item.checked})) }))
    ];
  }

  function validateNetworkResult(result){
    if(!result || typeof result!=='object' || typeof result.answer!=='string') return null;
    const allIds = new Set([...state.data.entries,...state.data.checklists].map(item=>item.id));
    const sourceIds = Array.isArray(result.sourceIds) ? result.sourceIds.filter(id=>typeof id==='string'&&allIds.has(id)).slice(0,3) : [];
    const primarySourceId = typeof result.primarySourceId==='string' && allIds.has(result.primarySourceId) ? result.primarySourceId : (sourceIds[0]||null);
    const allMemories=[...state.data.entries,...state.data.checklists];
    const source = allMemories.find(item=>item.id===primarySourceId) || null;
    const sources=sourceIds.map(id=>allMemories.find(item=>item.id===id)).filter(Boolean);
    return {
      answer:result.answer.slice(0,700), entry:source&&!Array.isArray(source.items)?source:null, checklist:source&&Array.isArray(source.items)?source:null,
      sources, primarySourceId, sourceIds, confidence:Number.isFinite(result.confidence)?Math.max(0,Math.min(1,result.confidence)):0,
      matchedFacts:Array.isArray(result.matchedFacts)?result.matchedFacts.filter(item=>typeof item==='string').slice(0,8):[], suggestedAction:typeof result.suggestedAction==='string'?result.suggestedAction:null
    };
  }

  async function callSecureAIEndpoint(question){
    if(!APP_CONFIG.enableNetworkAI || !AI_RUNTIME.endpoint) return null;
    const response = await fetch(AI_RUNTIME.endpoint, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ systemPrompt:AI_SYSTEM_PROMPT, question, SAVED_MEMORIES:savedMemoriesForNetwork() })
    });
    if(!response.ok) return null;
    return validateNetworkResult(await response.json());
  }

  function delayForDemo(ms){ return new Promise(resolve=>setTimeout(resolve,Math.max(0,ms))); }

  async function askAI(question){
    const local = resolveLocalQuestion(question);
    if(local) return local;
    try{
      const network = await callSecureAIEndpoint(question);
      if(network) return network;
    }catch(_error){ /* deterministic fallback below remains complete */ }
    return { answer:'I couldn’t find that in your saved memories.', sources:[], entry:null, checklist:null, primarySourceId:null, sourceIds:[], confidence:0, matchedFacts:[], suggestedAction:null, intentId:'not-found' };
  }

  /* ---- Ask modal UI ---- */
  function openAskModal(){
    const hadPlayback=!!state.playingId;
    stopPlayback();
    if(hadPlayback) render();
    state.modal = 'ask';
    state.draft = { question:'', loading:false, loadingStage:0, loadingStages:[], result:null };
    renderAskModal();
  }

  function loadingStagesFor(result){
    if(result && result.entry && result.entry.type==='voice') return ['Searching saved memories…','Reading voice transcript…','Preparing a grounded answer…'];
    if(result && result.checklist) return ['Checking current task state…','Finding incomplete items…','Preparing a grounded answer…'];
    return ['Searching saved memories…','Reading related screenshots and notes…','Preparing a grounded answer…'];
  }

  function renderAskProgress(d){
    return `<div class="ask-progress" aria-live="polite">${d.loadingStages.map((stage,index)=>`
      <div class="ask-progress-row ${index<d.loadingStage?'is-done':index===d.loadingStage?'is-current':''}">
        <span class="ask-progress-mark">${index<d.loadingStage?'✓':index===d.loadingStage?'•':'·'}</span><span>${esc(stage)}</span>
      </div>`).join('')}</div>`;
  }

  function renderAskModal(){
    const d = state.draft;
    const suggestions = buildSavedQuestionSuggestions(6);
    const memoryCount=allSavedMemories().length;
    modalRoot.innerHTML = `
      <div class="modal-overlay" data-overlay-close role="dialog" aria-modal="true">
        <div class="modal-box ask-box">
          <div class="modal-head">
            <div class="ask-head-copy">
              <span class="ask-head-icon">${ICONS.sparkle}</span>
              <div><div class="ask-head-kicker">Private · on this device</div><h3>Ask your mind</h3></div>
            </div>
            <div class="ask-head-actions"><span class="ask-library-status">${memoryCount} memories ready</span><button class="modal-close" data-close aria-label="Close">${ICONS.close}</button></div>
          </div>
          <div class="ask-composer">
            <textarea class="text-area" id="ask-question" rows="2" placeholder="Try ‘compare the shoes I saved’ or ask about anything here…" ${d.loading?'disabled':''}>${esc(d.question)}</textarea>
            <div class="ask-composer-foot">
              <span class="ask-composer-hint">Enter to ask · Shift + Enter for a new line</span>
              <button class="primary-btn ask-submit-btn" id="ask-submit" ${d.loading?'disabled':''}>${d.loading?'Thinking…':`${ICONS.sparkle}<span>Ask</span>`}</button>
            </div>
          </div>
          ${!d.loading&&!d.result&&suggestions.length ? `
            <section class="ask-prompt-section" aria-labelledby="saved-question-label">
              <div class="ask-prompt-head"><span class="ask-prompt-label" id="saved-question-label">Questions from your saved memories</span><span class="ask-prompt-note">Changes with your library</span></div>
              <div class="ask-suggestions">${suggestions.map(item=>`
                <button class="suggestion-chip" data-suggest="${esc(item.question)}">
                  <span class="suggestion-chip-icon">${ICONS.sparkle}</span>
                  <span class="suggestion-chip-copy"><span class="suggestion-chip-question">${esc(item.question)}</span><span class="suggestion-chip-source">From ${esc(item.sourceTitle)}</span></span>
                  <span class="suggestion-chip-arrow">→</span>
                </button>`).join('')}</div>
            </section>` : ''}
          ${d.loading ? renderAskProgress(d) : ''}
          ${d.result ? renderAskAnswer(d.result) : ''}
          <div class="ask-empty-note">Local recall · answers are grounded in the text, images, and live checklist state saved here.</div>
        </div>
      </div>
    `;
    bindModalCommon();
    const submit = async ()=>{
      const q = $('#ask-question').value.trim();
      if(!q){ showToast('Type a question first'); return; }
      d.question = q;
      d.loading = true; d.result = null;
      const result = await askAI(q);
      d.loadingStages = loadingStagesFor(result);
      d.loadingStage = 0;
      renderAskModal();
      const totalDelay = appearance.reducedMotion ? 0 : APP_CONFIG.simulatedAnalysisDelay;
      const stepDelay = totalDelay / d.loadingStages.length;
      for(let index=0; index<d.loadingStages.length; index++){
        d.loadingStage = index;
        if(state.modal==='ask' && state.draft===d) renderAskModal();
        await delayForDemo(stepDelay);
      }
      if(state.modal==='ask' && state.draft===d){
        d.loading = false; d.result = result;
        renderAskModal();
      }
    };
    $('#ask-submit').addEventListener('click', submit);
    modalRoot.querySelectorAll('[data-suggest]').forEach(button=>{
      button.addEventListener('click', ()=>{ $('#ask-question').value=button.dataset.suggest; submit(); });
    });
    $('#ask-question').addEventListener('keydown', e=>{
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); submit(); }
    });
    modalRoot.querySelectorAll('[data-goto-source]').forEach(sourceCard=>{
      sourceCard.addEventListener('click', ()=>{
        if(sourceCard.dataset.isChecklist==='true') navigateToChecklist(sourceCard.dataset.gotoSource,'home');
        else openDetailModal(sourceCard.dataset.gotoSource);
      });
      sourceCard.addEventListener('keydown', event=>{ if(event.key==='Enter'||event.key===' '){ event.preventDefault(); sourceCard.click(); } });
    });
    if(!d.loading) $('#ask-question').focus();
  }

  function renderAskAnswer(res){
    const allMemories=allSavedMemories();
    const sources=(res.sources&&res.sources.length ? res.sources : (res.sourceIds||[]).map(id=>allMemories.find(memory=>memory.id===id)).filter(Boolean));
    const sourceCards=sources.map((source,index)=>{
      const isChecklist = Array.isArray(source.items);
      const kindLabel = isChecklist ? 'Checklist' : {note:'Note', voice:'Voice note', screenshot:'Screenshot'}[source.type];
      const photo = (!isChecklist && source.photos && source.photos[0]) ? source.photos[0] : null;
      const done = isChecklist ? source.items.filter(item=>item.checked).length : 0;
      const sourceDetail = isChecklist ? `${done}/${source.items.length} complete` : (source.type==='voice' ? 'Transcript available' : (photo&&photo.caption ? photo.caption : fmtTime(source.createdAt)));
      return `
        <div class="ask-source ${index===0?'is-primary':''}" role="button" tabindex="0" data-goto-source="${esc(source.id)}" data-is-checklist="${isChecklist}">
          ${photo ? `<div class="ask-source-thumb" role="img" aria-label="${esc(photo.alt||photo.caption||source.title)}" style="background-image:url('${esc(photo.dataUrl)}')"></div>` : `<div class="ask-source-thumb"><div class="source-icon">${isChecklist?ICONS.checklist:source.type==='voice'?ICONS.mic:ICONS.note}</div></div>`}
          <div class="ask-source-meta">
            <div class="ask-source-type">${esc(kindLabel)}</div>
            <div class="ask-source-title">${esc(source.title||'Untitled')}</div>
            <div class="ask-source-detail">${esc(sourceDetail)}</div>
            ${isChecklist?`<div class="checklist-meter"><span style="width:${source.items.length?Math.round(done/source.items.length*100):0}%"></span></div>`:''}
            <span class="ask-source-open">Open memory →</span>
          </div>
        </div>`;
    }).join('');
    const sourceCount=sources.length;
    return `
      <div class="ask-answer">
        <div class="ask-answer-head"><span class="ask-answer-label">Grounded answer</span><span class="answer-basis">Based on ${sourceCount} saved ${sourceCount===1?'memory':'memories'}</span></div>
        <div class="ask-answer-text">${esc(res.answer)}</div>
        ${sourceCards?`<div class="ask-sources ${sourceCount===1?'is-single':''}" aria-label="Answer sources">${sourceCards}</div>`:''}
      </div>
    `;
  }

  /* ---- NOTE MODAL ---- */
  function renderNoteModal(){
    const d = state.draft;
    modalRoot.innerHTML = `
      <div class="modal-overlay" data-overlay-close role="dialog" aria-modal="true">
        <div class="modal-box">
          <div class="modal-head"><h3>Write a note</h3><button class="modal-close" data-close aria-label="Close">${ICONS.close}</button></div>
          <div class="field"><label class="field-label">Title</label><input class="text-input" id="note-title" placeholder="Give it a name..." value="${esc(d.title||'')}"></div>
          <div class="field"><label class="field-label">Note</label><textarea class="text-area" id="note-text" placeholder="Write what's on your mind...">${esc(d.text||'')}</textarea></div>
          <div class="field">
            <label class="field-label">Photo</label>
            <button class="ghost-btn" id="note-add-photo">${ICONS.image} Add photo</button>
            <input type="file" accept="image/*" id="note-photo-input" style="display:none">
            ${photoStripHtml()}
          </div>
          <div class="modal-actions">
            <button class="ghost-btn" data-close>Cancel</button>
            <button class="primary-btn" id="note-save" ${anyPhotoAnalyzing()?'disabled':''}>Save note</button>
          </div>
        </div>
      </div>
    `;
    bindModalCommon();
    bindPhotoStripEvents(renderNoteModal);
    $('#note-title').addEventListener('input', e=>{ d.title = e.target.value; });
    $('#note-text').addEventListener('input', e=>{ d.text = e.target.value; });
    $('#note-add-photo').addEventListener('click', ()=> $('#note-photo-input').click());
    $('#note-photo-input').addEventListener('change', e=>{
      d.title = $('#note-title').value; d.text = $('#note-text').value;
      if(e.target.files[0]) addPhotoFromFile(e.target.files[0], renderNoteModal);
    });
    $('#note-save').addEventListener('click', async ()=>{
      const title = $('#note-title').value.trim();
      const text = $('#note-text').value.trim();
      if(!title && !text && !state.draft.photos.length){ showToast('Add some content first'); return; }
      const entry = { id: state.draft.id, type:'note', title: title||'Untitled note', text, audio:null, photos: state.draft.photos.map(p=>({id:p.id,dataUrl:p.dataUrl,caption:p.caption,alt:p.alt||p.caption||title||'Saved image'})), createdAt: new Date().toISOString() };
      state.data.entries.push(entry);
      const ok = await saveData();
      if(!ok) showToast('Saved for this session (storage limit reached)');
      closeModal();
      setView('home');
    });
  }

  /* ---- VOICE MODAL ---- */
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null, liveTranscript = '';

  function renderVoiceModal(){
    const d = state.draft;
    modalRoot.innerHTML = `
      <div class="modal-overlay" data-overlay-close role="dialog" aria-modal="true">
        <div class="modal-box">
          <div class="modal-head"><h3>Record a voice note</h3><button class="modal-close" data-close aria-label="Close">${ICONS.close}</button></div>
          <div class="field"><label class="field-label">Title</label><input class="text-input" id="voice-title" placeholder="Give it a name..." value="${esc(d.title||'')}"></div>
          <div class="field">
            <label class="field-label">Recording</label>
            <div class="row-flex">
              <button class="ghost-btn ${d.recording?'rec-active':''}" id="rec-toggle">
                ${d.recording ? ICONS.stop+' Stop' : ICONS.mic+' Record'}
              </button>
              ${d.recording ? `<span class="rec-timer" id="rec-timer">0:00</span>` : ''}
            </div>
            ${d.audioDataUrl ? `<audio class="audio-preview" controls src="${d.audioDataUrl}"></audio>` : ''}
            ${d.demoLoading ? `<div class="waveform" aria-label="Simulating a demo recording">${Array.from({length:28},()=>'<i></i>').join('')}</div><div class="local-analysis"><div class="spinner"></div> Preparing local transcript…</div>` : ''}
            <div class="demo-capture">
              <div class="demo-capture-title">Try a demo capture</div>
              <button class="ghost-btn" id="voice-demo" ${d.demoLoading?'disabled':''}>${ICONS.play} Use demo recording</button>
            </div>
          </div>
          <div class="field"><label class="field-label">Transcript</label><textarea class="text-area manual-transcript" id="voice-transcript" placeholder="Speech transcript or a manual note…">${esc(d.transcript||'')}</textarea></div>
          <div class="field"><label class="field-label">Notes (optional)</label><textarea class="text-area" id="voice-text" placeholder="Any text to go with this...">${esc(d.text||'')}</textarea></div>
          ${d.summaryLines&&d.summaryLines.length?`<div class="field"><div class="ai-summary-label">Local summary</div><ul class="ai-summary-list">${d.summaryLines.map(line=>`<li>${esc(line)}</li>`).join('')}</ul></div>`:''}
          <div class="field">
            <label class="field-label">Photo</label>
            <button class="ghost-btn" id="voice-add-photo">${ICONS.image} Add photo</button>
            <input type="file" accept="image/*" id="voice-photo-input" style="display:none">
            ${photoStripHtml()}
          </div>
          <div class="modal-actions">
            <button class="ghost-btn" data-close>Cancel</button>
            <button class="primary-btn" id="voice-save" ${anyPhotoAnalyzing()?'disabled':''}>Save voice note</button>
          </div>
        </div>
      </div>
    `;
    bindModalCommon();
    bindPhotoStripEvents(renderVoiceModal);
    $('#voice-title').addEventListener('input', e=>{ d.title = e.target.value; });
    $('#voice-text').addEventListener('input', e=>{ d.text = e.target.value; });
    $('#voice-transcript').addEventListener('input', e=>{ d.transcript = e.target.value; });
    $('#voice-add-photo').addEventListener('click', ()=> $('#voice-photo-input').click());
    $('#voice-photo-input').addEventListener('change', e=>{
      d.title = $('#voice-title').value; d.text = $('#voice-text').value;
      if(e.target.files[0]) addPhotoFromFile(e.target.files[0], renderVoiceModal);
    });
    if(d.recording){
      let seconds = d.recSeconds||0;
      d.recTimerHandle = setInterval(()=>{
        seconds++; d.recSeconds=seconds;
        const el = $('#rec-timer');
        if(el) el.textContent = Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
      },1000);
    }
    $('#rec-toggle').addEventListener('click', async ()=>{
      const titleVal = $('#voice-title').value;
      const textVal = $('#voice-text').value;
      d.text = textVal; d.title = titleVal; d.transcript = $('#voice-transcript').value;
      if(!d.recording){
        const ok = await startRecording();
        if(!ok){ showToast('Microphone access denied or unavailable'); return; }
        d.recording = true; d.recSeconds=0;
        renderVoiceModal();
      } else {
        if(d.recTimerHandle) clearInterval(d.recTimerHandle);
        const dataUrl = await stopRecording();
        d.recording = false;
        d.audioDataUrl = dataUrl;
        d.transcript = liveTranscript.trim() || d.transcript || '';
        renderVoiceModal();
      }
    });
    $('#voice-demo').addEventListener('click', async ()=>{
      d.title=$('#voice-title').value; d.text=$('#voice-text').value; d.transcript=$('#voice-transcript').value;
      d.demoLoading=true; renderVoiceModal();
      await delayForDemo(appearance.reducedMotion?0:APP_CONFIG.simulatedAnalysisDelay);
      if(state.modal!=='voice' || state.draft!==d) return;
      const sample=createSeedData().entries.find(item=>item.demoKey==='client-call');
      Object.assign(d,{ title:sample.title,text:sample.text,transcript:sample.transcript,audioText:sample.audioText,summaryLines:sample.summaryLines,tags:sample.tags,synonyms:sample.synonyms,metadata:sample.metadata,demoKey:sample.demoKey,demoId:sample.id,demoLoading:false });
      renderVoiceModal();
    });
    $('#voice-save').addEventListener('click', async ()=>{
      const title = $('#voice-title').value.trim();
      const text = $('#voice-text').value.trim();
      const transcript = $('#voice-transcript').value.trim();
      if(!d.audioDataUrl && !text && !transcript && !d.photos.length){ showToast('Record something or add a transcript first'); return; }
      const entry = { id:d.demoId||d.id, demoKey:d.demoKey, type:'voice', title:title||'Untitled voice note', text, audio:d.audioDataUrl||null, audioText:d.audioText||transcript, transcript, photos:d.photos.map(p=>({id:p.id,dataUrl:p.dataUrl,caption:p.caption,alt:p.alt||p.caption||title||'Saved image'})), summaryLines:d.summaryLines||[], tags:d.tags||[], synonyms:d.synonyms||[], metadata:d.metadata||{}, important:d.demoKey==='client-call', createdAt:new Date().toISOString() };
      if(entry.demoKey) upsertDemoEntry(entry); else state.data.entries.push(entry);
      const ok = await saveData();
      if(!ok) showToast('Saved for this session (storage limit reached)');
      closeModal();
      setView('home');
      if(entry.transcript && !entry.summaryLines.length && state.appSettings.aiSummaries) generateVoiceSummary(entry);
    });
  }

  let mediaRecorder=null, audioChunks=[];
  async function startRecording(){
    try{
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      state.draft.recordingStream = stream;
      audioChunks = [];
      liveTranscript = '';
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e=>{ if(e.data.size>0) audioChunks.push(e.data); };
      mediaRecorder.start();
      if(SpeechRecognitionAPI){
        recognizer = new SpeechRecognitionAPI();
        recognizer.continuous = true;
        recognizer.interimResults = false;
        recognizer.lang = 'en-US';
        recognizer.onresult = (e)=>{
          for(let i=e.resultIndex; i<e.results.length; i++){
            if(e.results[i].isFinal) liveTranscript += e.results[i][0].transcript + ' ';
          }
        };
        recognizer.onerror = ()=>{};
        try{ recognizer.start(); }catch(e){}
      }
      return true;
    }catch(_error){
      return false;
    }
  }
  function stopRecording(){
    return new Promise(resolve=>{
      if(recognizer){ try{ recognizer.stop(); }catch(e){} }
      if(!mediaRecorder){ resolve(null); return; }
      mediaRecorder.onstop = ()=>{
        const blob = new Blob(audioChunks, {type: mediaRecorder.mimeType || 'audio/webm'});
        if(state.draft.recordingStream) state.draft.recordingStream.getTracks().forEach(t=>t.stop());
        const reader = new FileReader();
        reader.onloadend = ()=> resolve(reader.result);
        reader.readAsDataURL(blob);
      };
      mediaRecorder.stop();
    });
  }

  /* ---- SCREENSHOT MODAL ---- */
  async function loadDemoScreenshot(demoKey, draft){
    draft.title=$('#ss-title').value; draft.text=$('#ss-text').value;
    draft.demoLoading=true; draft.analyzingShot=true; draft.detectedFacts=null;
    renderScreenshotModal();
    await delayForDemo(appearance.reducedMotion?0:APP_CONFIG.simulatedAnalysisDelay);
    if(state.modal!=='screenshot' || state.draft!==draft) return;
    const sample=createSeedData().entries.find(item=>item.demoKey===demoKey);
    if(!sample) return;
    const photo=sample.photos[0];
    Object.assign(draft,{
      title:sample.title,text:sample.text,screenshotUrl:photo.dataUrl,captionText:photo.caption,photoAlt:photo.alt,
      summaryLines:sample.summaryLines,tags:sample.tags,synonyms:sample.synonyms,metadata:sample.metadata,important:sample.important,
      demoKey:sample.demoKey,demoId:sample.id,demoLoading:false,analyzingShot:false
    });
    if(demoKey==='shoes') draft.detectedFacts={Product:sample.metadata.product,Price:sample.metadata.price,Colour:sample.metadata.colour,Size:sample.metadata.selectedSize};
    else if(demoKey==='goa-trip') draft.detectedFacts={Destination:sample.metadata.destination,Dates:sample.metadata.dates,Fare:sample.metadata.fare,Status:'Return booked'};
    else draft.detectedFacts={Topic:sample.metadata.topic||'Source-backed memory',Format:'Research article'};
    renderScreenshotModal();
  }

  function renderScreenshotModal(){
    const d = state.draft;
    modalRoot.innerHTML = `
      <div class="modal-overlay" data-overlay-close role="dialog" aria-modal="true">
        <div class="modal-box">
          <div class="modal-head"><h3>Take a screenshot</h3><button class="modal-close" data-close aria-label="Close">${ICONS.close}</button></div>
          <div class="field">
            <div class="capture-area" id="capture-area">
              ${d.screenshotUrl ? `<img src="${d.screenshotUrl}" alt="${esc(d.photoAlt||d.captionText||d.title||'Screenshot preview')}">` : `<span class="capture-hint">No image captured yet</span>`}
            </div>
            <div class="row-flex" style="margin-top:10px;">
              <button class="ghost-btn" id="capture-btn" ${d.analyzingShot?'disabled':''}>${ICONS.camera} Capture screen</button>
              <button class="ghost-btn" id="upload-btn" ${d.analyzingShot?'disabled':''}>${ICONS.upload} Upload image</button>
              <input type="file" accept="image/*" id="screenshot-file-input" style="display:none">
            </div>
            ${d.captionText ? `<div class="voice-time" style="margin-top:8px;font-style:italic;">${esc(d.captionText)}</div>` : ''}
            ${d.analyzingShot ? `<div class="local-analysis"><div class="spinner"></div> Reading screenshot locally…</div>` : ''}
            <div class="demo-capture">
              <div class="demo-capture-title">Try a demo capture</div>
              <div class="demo-chip-row">
                <button class="demo-chip" data-demo-screenshot="shoes" ${d.analyzingShot?'disabled':''}>Running shoes</button>
                <button class="demo-chip" data-demo-screenshot="goa-trip" ${d.analyzingShot?'disabled':''}>Goa itinerary</button>
                <button class="demo-chip" data-demo-screenshot="research" ${d.analyzingShot?'disabled':''}>Research article</button>
              </div>
            </div>
            ${d.detectedFacts?`<div class="detected-facts">${Object.entries(d.detectedFacts).map(([label,value])=>`<div class="detected-fact"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>`:''}
          </div>
          <div class="field"><label class="field-label">Title</label><input class="text-input" id="ss-title" placeholder="Give it a name..." value="${esc(d.title||'')}"></div>
          <div class="field"><label class="field-label">Note (optional)</label><textarea class="text-area" id="ss-text" placeholder="What's this about?">${esc(d.text||'')}</textarea></div>
          <div class="field">
            <label class="field-label">Voice note (optional)</label>
            <div class="row-flex">
              <button class="ghost-btn ${d.recording?'rec-active':''}" id="ss-rec-toggle">${d.recording?ICONS.stop+' Stop':ICONS.mic+' Record'}</button>
              ${d.recording ? `<span class="rec-timer" id="ss-rec-timer">0:00</span>` : ''}
            </div>
            ${d.audioDataUrl ? `<audio class="audio-preview" controls src="${d.audioDataUrl}"></audio>` : ''}
          </div>
          <div class="modal-actions">
            <button class="ghost-btn" data-close>Cancel</button>
            <button class="primary-btn" id="ss-save" ${d.analyzingShot?'disabled':''}>Save screenshot</button>
          </div>
        </div>
      </div>
    `;
    bindModalCommon();
    $('#ss-title').addEventListener('input', e=>{ d.title = e.target.value; });
    $('#ss-text').addEventListener('input', e=>{ d.text = e.target.value; });
    modalRoot.querySelectorAll('[data-demo-screenshot]').forEach(button=>button.addEventListener('click',()=>loadDemoScreenshot(button.dataset.demoScreenshot,d)));
    if(d.recording){
      let seconds = d.recSeconds||0;
      d.recTimerHandle = setInterval(()=>{
        seconds++; d.recSeconds=seconds;
        const el = $('#ss-rec-timer');
        if(el) el.textContent = Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
      },1000);
    }
    $('#capture-btn').addEventListener('click', async ()=>{
      d.title = $('#ss-title').value; d.text = $('#ss-text').value;
      const url = await captureScreen();
      if(!url){ showToast('Screen capture unavailable — upload an image or try a demo capture'); return; }
      d.screenshotUrl = url;
      d.demoKey=null; d.demoId=null; d.detectedFacts=null; d.photoAlt='Captured screen image';
      d.analyzingShot = true;
      renderScreenshotModal();
      d.captionText = await generateCaption(url);
      d.analyzingShot = false;
      renderScreenshotModal();
    });
    $('#upload-btn').addEventListener('click', ()=> $('#screenshot-file-input').click());
    $('#screenshot-file-input').addEventListener('change', async e=>{
      const file = e.target.files[0];
      if(!file) return;
      d.title = $('#ss-title').value; d.text = $('#ss-text').value;
      const reader = new FileReader();
      reader.onload = async ()=>{
        d.screenshotUrl = reader.result;
        d.photoAlt = file.name ? `Uploaded image: ${file.name}` : 'Uploaded screenshot';
        d.demoKey = null; d.demoId = null; d.detectedFacts = null;
        d.analyzingShot = true;
        renderScreenshotModal();
        d.captionText = await generateCaption(reader.result);
        d.analyzingShot = false;
        renderScreenshotModal();
      };
      reader.readAsDataURL(file);
    });
    $('#ss-rec-toggle').addEventListener('click', async ()=>{
      d.title = $('#ss-title').value; d.text = $('#ss-text').value;
      if(!d.recording){
        const ok = await startRecording();
        if(!ok){ showToast('Microphone access denied or unavailable'); return; }
        d.recording = true; d.recSeconds = 0;
        renderScreenshotModal();
      } else {
        if(d.recTimerHandle) clearInterval(d.recTimerHandle);
        const dataUrl = await stopRecording();
        d.recording = false;
        d.audioDataUrl = dataUrl;
        renderScreenshotModal();
      }
    });
    $('#ss-save').addEventListener('click', async ()=>{
      const title = $('#ss-title').value.trim();
      const text = $('#ss-text').value.trim();
      if(!d.screenshotUrl){ showToast('Capture or upload an image first'); return; }
      const entry = {
        id:d.demoId||d.id, demoKey:d.demoKey||undefined, type:'screenshot', title:title||'Untitled screenshot', text,
        audio: d.audioDataUrl||null,
        photos:[{ id:d.demoKey?`demo-${d.demoKey}-photo`:uid(), dataUrl:d.screenshotUrl, caption:d.captionText||'Uploaded image saved for later recall.', alt:d.photoAlt||d.captionText||title||'Saved screenshot' }],
        summaryLines:d.summaryLines||[], tags:d.tags||[], synonyms:d.synonyms||[], metadata:d.metadata||{}, important:!!d.important,
        createdAt: new Date().toISOString()
      };
      if(entry.demoKey) upsertDemoEntry(entry); else state.data.entries.push(entry);
      const ok = await saveData();
      if(!ok) showToast('Saved for this session (storage limit reached)');
      closeModal();
      setView('home');
    });
  }

  async function captureScreen(){
    try{
      const stream = await navigator.mediaDevices.getDisplayMedia({video:true});
      const track = stream.getVideoTracks()[0];
      let dataUrl;
      if('ImageCapture' in window){
        const capture = new ImageCapture(track);
        const bitmap = await capture.grabFrame();
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap,0,0);
        dataUrl = canvas.toDataURL('image/png');
      } else {
        const video = document.createElement('video');
        video.srcObject = stream;
        await video.play();
        await new Promise(r=>setTimeout(r,250));
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video,0,0);
        dataUrl = canvas.toDataURL('image/png');
      }
      stream.getTracks().forEach(t=>t.stop());
      return dataUrl;
    }catch(_error){
      return null;
    }
  }

  async function captureScreenFromStreamId(streamId){
    let stream = null;
    try{
      stream = await navigator.mediaDevices.getUserMedia({
        video:{
          mandatory:{
            chromeMediaSource:'desktop',
            chromeMediaSourceId:streamId
          }
        }
      });
    }catch(_error){
      console.error(
        'ThinkSync: getUserMedia(streamId) failed —', _error && _error.name, '/', _error && _error.message, _error
      );
      return null;
    }

    try{
      // Deliberately NOT using ImageCapture/grabFrame() here. Chrome can
      // throw a DOMException from grabFrame() on chromeMediaSource:'desktop'
      // streams if it's called before the stream has actually decoded a
      // real frame — a timing quirk specific to this legacy capture path
      // (getDisplayMedia-sourced streams, used elsewhere in this file for
      // manual "Capture screen", don't hit this). Instead: play the stream
      // into a <video> element and wait until it reports real pixel
      // dimensions before drawing it to canvas — reliable across
      // machines/OSes instead of guessing a fixed delay.
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      await waitForVideoFrame(video);
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video,0,0);
      return canvas.toDataURL('image/png');
    }catch(_error){
      console.error(
        'ThinkSync: capturing a frame from the desktop stream failed —', _error && _error.name, '/', _error && _error.message, _error
      );
      return null;
    }finally{
      stream.getTracks().forEach(t=>t.stop());
    }
  }

  function waitForVideoFrame(video, timeoutMs){
    timeoutMs = timeoutMs || 4000;
    return new Promise((resolve, reject)=>{
      const start = Date.now();
      (function check(){
        if(video.videoWidth > 0 && video.videoHeight > 0){
          resolve();
          return;
        }
        if(Date.now() - start > timeoutMs){
          reject(new Error('Timed out waiting for a decoded frame from the desktop capture stream.'));
          return;
        }
        requestAnimationFrame(check);
      })();
    });
  }

  async function runAutoCaptureFromExtension(){
    if(!__pendingAutoCapture){
      console.warn('ThinkSync: no capture was in flight (picker was likely cancelled).');
      return;
    }
    const url = await __pendingAutoCapture;
    __pendingAutoCapture = null;
    if(!url){
      console.warn('ThinkSync: captureScreenFromStreamId returned no image — getUserMedia failed or streamId expired.');
      showToast('Screen capture unavailable — use Capture screen or upload an image');
      return;
    }

    const captionText = await generateCaption(url);
    const entry = {
      id: uid(), type:'screenshot', title:'Untitled screenshot', text:'',
      audio:null,
      photos:[{ id:uid(), dataUrl:url, caption:captionText||'Captured screen image saved for later recall.', alt:'Captured screen image' }],
      summaryLines:[], tags:[], synonyms:[], metadata:{}, important:false,
      createdAt:new Date().toISOString()
    };
    state.data.entries.push(entry);
    const ok = await saveData();
    if(!ok) showToast('Saved for this session (storage limit reached)');
    render();
    openEditEntryModal(entry.id);
  }

  /* ---- CHECKLIST MODAL ---- */
  function renderChecklistModal(){
    const d = state.draft;
    if(!d.items) d.items = [{id:uid(),text:''},{id:uid(),text:''},{id:uid(),text:''}];
    modalRoot.innerHTML = `
      <div class="modal-overlay" data-overlay-close role="dialog" aria-modal="true">
        <div class="modal-box">
          <div class="modal-head"><h3>New checklist</h3><button class="modal-close" data-close aria-label="Close">${ICONS.close}</button></div>
          <div class="field"><label class="field-label">Title</label><input class="text-input" id="cl-title" placeholder="Name this checklist..." value="${esc(d.title||'')}"></div>
          <div class="field">
            <label class="field-label">Steps</label>
            <div id="cl-items">
              ${d.items.map((it,i)=>`
                <div class="checklist-editor-row" data-item-row="${it.id}">
                  <input class="text-input" data-item-input="${it.id}" placeholder="Step ${i+1}..." value="${esc(it.text)}">
                  <button class="icon-btn-sm" data-remove-item="${it.id}" aria-label="Remove step">${ICONS.close}</button>
                </div>`).join('')}
            </div>
            <button class="ghost-btn" id="cl-add-item">${ICONS.plus} Add step</button>
          </div>
          <div class="modal-actions">
            <button class="ghost-btn" data-close>Cancel</button>
            <button class="primary-btn" id="cl-save">Save checklist</button>
          </div>
        </div>
      </div>
    `;
    bindModalCommon();
    function syncItemsFromDom(){
      d.items.forEach(it=>{
        const inp = modalRoot.querySelector(`[data-item-input="${it.id}"]`);
        if(inp) it.text = inp.value;
      });
      d.title = $('#cl-title').value;
    }
    modalRoot.querySelectorAll('[data-remove-item]').forEach(el=>{
      el.addEventListener('click', ()=>{
        syncItemsFromDom();
        d.items = d.items.filter(it=>it.id!==el.dataset.removeItem);
        renderChecklistModal();
      });
    });
    $('#cl-add-item').addEventListener('click', ()=>{
      syncItemsFromDom();
      d.items.push({id:uid(),text:''});
      renderChecklistModal();
      const inputs = modalRoot.querySelectorAll('[data-item-input]');
      if(inputs.length) inputs[inputs.length-1].focus();
    });
    $('#cl-save').addEventListener('click', async ()=>{
      syncItemsFromDom();
      const title = d.title.trim();
      const items = d.items.filter(it=>it.text.trim()).map(it=>({id:it.id, text:it.text.trim(), checked:false}));
      if(!title || !items.length){ showToast('Add a title and at least one step'); return; }
      const checklist = { id: d.id, title, items, createdAt: new Date().toISOString() };
      state.data.checklists.push(checklist);
      const ok = await saveData();
      if(!ok) showToast('Saved for this session (storage limit reached)');
      closeModal();
      setView('home');
    });
  }

  /* ============ SEARCH BAR ============ */
  const searchInput = $('#search-input');
  searchInput.addEventListener('input', ()=>{
    const q = searchInput.value.trim();
    if(q && state.view!=='search'){ state.prevView = state.view; }
    state.searchQuery = q;
    if(q){ state.view='search'; renderSearch(); }
    else { setView(state.prevView||'home'); }
  });

  let searchRecognizer = null, listening=false;
  const micBtn = $('#search-mic-btn');
  if(SpeechRecognitionAPI){
    searchRecognizer = new SpeechRecognitionAPI();
    searchRecognizer.continuous = false;
    searchRecognizer.interimResults = false;
    searchRecognizer.onresult = (e)=>{
      const transcript = e.results[0][0].transcript;
      searchInput.value = transcript;
      searchInput.dispatchEvent(new Event('input'));
    };
    searchRecognizer.onend = ()=>{ listening=false; micBtn.classList.remove('listening'); };
    searchRecognizer.onerror = ()=>{ listening=false; micBtn.classList.remove('listening'); };
  }
  micBtn.addEventListener('click', ()=>{
    if(!searchRecognizer){ showToast('Voice search is not supported in this browser'); return; }
    if(listening){ searchRecognizer.stop(); listening=false; micBtn.classList.remove('listening'); return; }
    try{ searchRecognizer.start(); listening=true; micBtn.classList.add('listening'); }catch(e){}
  });

  /* ============ SIDEBAR BINDINGS ============ */
  document.querySelectorAll('.nav-item[data-view]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      searchInput.value=''; state.searchQuery='';
      setView(btn.dataset.view);
      btn.blur();
    });
  });
  /* ============ LOGO INVERT EASTER EGG ============ */
  const logoMarkBtn = document.getElementById('logo-mark-btn');
  if(logoMarkBtn){
    const toggleInvert = ()=>{ appearance.tinted = !appearance.tinted; applyAppearance(true); };
    logoMarkBtn.addEventListener('click', toggleInvert);
    logoMarkBtn.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleInvert(); } });
  }

  /* ============ ASK FAB ============ */
  const askFabBtn = document.getElementById('ask-fab-btn');
  if(askFabBtn){ askFabBtn.title='Ask AI (Ctrl/Cmd + K)'; askFabBtn.addEventListener('click', ()=> openAskModal()); }

  /* ============ KEYBOARD SHORTCUTS ============ */
  document.addEventListener('keydown', event=>{
    const target=event.target;
    const isTyping=target && (target.matches?.('input, textarea, select') || target.isContentEditable);
    if(event.key==='Escape' && state.modal){ event.preventDefault(); closeModal(); return; }
    if((event.metaKey||event.ctrlKey) && event.key.toLowerCase()==='k'){
      event.preventDefault(); openAskModal(); return;
    }
    if(!isTyping && event.key==='/' && !event.metaKey && !event.ctrlKey && !event.altKey){
      event.preventDefault(); searchInput.focus(); return;
    }
    if(!isTyping && event.altKey && event.shiftKey && event.key.toLowerCase()==='s'){
      event.preventDefault(); openCreateModal('screenshot'); return;
    }
    if(!isTyping && event.altKey && event.shiftKey && event.key.toLowerCase()==='v'){
      event.preventDefault(); openCreateModal('voice');
    }
  });

  /* ============ INIT ============ */
  async function init(){
    updateClock();
    setInterval(updateClock, 1000);
    setInterval(updateGreeting, 60000);
    await loadTheme();
    await loadData();
    render();
    const initialized=await storageGet(DEMO_INIT_KEY);
    if(state.firstRun && initialized!==String(APP_CONFIG.seedVersion)){
      await storageSet(DEMO_INIT_KEY,String(APP_CONFIG.seedVersion));
      showToast('Your local demo library is ready.');
    }else if(state.libraryUpgraded && initialized!==String(APP_CONFIG.seedVersion)){
      await storageSet(DEMO_INIT_KEY,String(APP_CONFIG.seedVersion));
      showToast('10 new visual memories added to your library.');
    }
    await runAutoCaptureFromExtension();
  }
  init().catch(()=>{
    state.data=createSeedData();
    applyAppearance(false);
    render();
    showToast('Local demo library loaded for this session.');
  });

})();