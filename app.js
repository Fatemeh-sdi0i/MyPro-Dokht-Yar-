const orders = [
 {id:"۱۴۰۵-۰۲۱",customer:"مریم احمدی",type:"sewing",desc:"دوخت لباس مجلسی",created:"۱۴۰۵/۰۸/۱۰",due:"۱۴۰۵/۰۸/۱۴",status:"progress",price:8500000},
 {id:"۱۴۰۵-۰۲۰",customer:"نگار رضایی",type:"repair",desc:"تعمیر و اصلاح مانتو",created:"۱۴۰۵/۰۸/۰۹",due:"۱۴۰۵/۰۸/۱۲",status:"ready",price:450000},
 {id:"۱۴۰۵-۰۱۹",customer:"سارا موسوی",type:"sewing",desc:"دوخت مانتو",created:"۱۴۰۵/۰۸/۰۷",due:"۱۴۰۵/۰۸/۱۵",status:"delivered",price:6200000},
 {id:"۱۴۰۵-۰۱۸",customer:"الهام کریمی",type:"repair",desc:"کوتاهی و اصلاح لباس",created:"۱۴۰۵/۰۸/۰۶",due:"۱۴۰۵/۰۸/۱۳",status:"waiting",price:380000},
 {id:"۱۴۰۵-۰۱۷",customer:"پریا کاوه",type:"sewing",desc:"دوخت کت و دامن",created:"۱۴۰۵/۰۸/۰۵",due:"۱۴۰۵/۰۸/۱۶",status:"progress",price:7400000}
];
const customers = [
 {name:"مریم احمدی",phone:"۰۹۱۲۳۴۵۶۷۸۹",count:5,last:"۱۴۰۵/۰۸/۱۴",state:"فعال",note:"مشتری دائمی و بسیار خوش‌سلیقه است."},
 {name:"نگار رضایی",phone:"۰۹۳۵۸۷۶۵۴۳۲",count:7,last:"۱۴۰۵/۰۸/۱۰",state:"VIP",note:"ترجیح می‌دهد قبل از شروع کار، مدل نهایی تأیید شود."},
 {name:"سارا موسوی",phone:"۰۹۱۱۷۶۵۴۳۲۱",count:2,last:"۱۴۰۵/۰۸/۰۹",state:"معمولی",note:""},
 {name:"الهام کریمی",phone:"۰۹۸۷۶۵۴۳۲۱",count:3,last:"۱۴۰۵/۰۸/۰۵",state:"فعال",note:""},
 {name:"پریا کاوه",phone:"۰۹۳۷۸۹۱۲۳۴۵",count:4,last:"۱۴۰۵/۰۸/۰۱",state:"معمولی",note:""}
];
const statusText={progress:"در حال دوخت",ready:"آماده تحویل",delivered:"تحویل شده",waiting:"در انتظار شروع"};
const typeText={sewing:"دوخت لباس",repair:"تعمیرات"};
let activeFilter="all";
const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2300)}
function go(page){$$(".page").forEach(p=>p.classList.toggle("active",p.id===page));$$(".nav-item").forEach(n=>n.classList.toggle("active",n.dataset.page===page));window.scrollTo({top:0,behavior:"smooth"})}
$$(".nav-item").forEach(b=>b.addEventListener("click",()=>go(b.dataset.page)));
$$("[data-goto]").forEach(b=>b.addEventListener("click",()=>go(b.dataset.goto)));
function renderOrders(){
 const q=($("#orderSearch")?.value||"").trim().toLowerCase();
 const status=$('input[name="status"]:checked')?.value||"all";
 const kinds=$$('input[name="kind"]:checked').map(x=>x.value);
 const filtered=orders.filter(o=>(activeFilter==="all"||(activeFilter==="sewing"&&o.type==="sewing")||(activeFilter==="repair"&&o.type==="repair")||(activeFilter===o.status)||(activeFilter==="progress"&&o.status==="progress"))&&(status==="all"||o.status===status)&&kinds.includes(o.type)&&(!q||[o.id,o.customer,o.desc].join(" ").toLowerCase().includes(q)));
 $("#ordersBody").innerHTML=filtered.map(o=>`<tr><td><span class="order-thumb">${o.type==="repair"?"✂":"♟"}</span></td><td>${o.id}</td><td>${typeText[o.type]}</td><td>${o.customer}</td><td>${o.created}</td><td>${o.due}</td><td><span class="status ${o.status}">${statusText[o.status]}</span></td><td><button class="dots" title="تغییر وضعیت" data-status="${o.id}">•••</button></td></tr>`).join("")||'<tr><td colspan="8">سفارشی با این مشخصات پیدا نشد.</td></tr>';
 $$("[data-status]").forEach(b=>b.addEventListener("click",()=>{const o=orders.find(x=>x.id===b.dataset.status);const next={waiting:"progress",progress:"ready",ready:"delivered",delivered:"waiting"};o.status=next[o.status];renderOrders();toast("وضعیت سفارش به «"+statusText[o.status]+"» تغییر کرد.")}));
}
$$(".chip").forEach(b=>b.addEventListener("click",()=>{$$(".chip").forEach(x=>x.classList.remove("selected"));b.classList.add("selected");activeFilter=b.dataset.filter;renderOrders()}));
$("#orderSearch").addEventListener("input",renderOrders);$$('input[name="status"],input[name="kind"]').forEach(x=>x.addEventListener("change",renderOrders));
$("#resetFilters").addEventListener("click",()=>{$('input[name="status"][value="all"]').checked=true;$$('input[name="kind"]').forEach(x=>x.checked=true);activeFilter="all";$$(".chip").forEach(x=>x.classList.toggle("selected",x.dataset.filter==="all"));renderOrders()});
function renderCustomers(){
 const q=($("#customerSearch")?.value||"").trim();
 const rows=customers.filter(c=>!q||(c.name+c.phone).includes(q));
 $("#customersBody").innerHTML=rows.map((c,i)=>`<tr data-customer="${customers.indexOf(c)}"><td><span class="mini-avatar">${c.name[0]}</span></td><td>${c.name}</td><td>${c.phone}</td><td>${c.count}</td><td>${c.last}</td><td><span class="status ${c.state==="فعال"?"delivered":c.state==="VIP"?"progress":"ready"}">${c.state}</span></td><td><button class="dots" data-detail="${customers.indexOf(c)}">•••</button></td></tr>`).join("")||'<tr><td colspan="7">مشتری پیدا نشد.</td></tr>';
 $$("[data-customer]").forEach(r=>r.addEventListener("click",()=>showCustomer(+r.dataset.customer)));
 $$("[data-detail]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();showCustomer(+b.dataset.detail)}));
 $("#customerCount").textContent=(45+Math.max(0,customers.length-5)).toLocaleString("fa-IR");
}
function showCustomer(i){const c=customers[i];$("#customerDetail").innerHTML=`<h3>مشخصات مشتری</h3><div class="customer-profile"><div class="avatar">${c.name[0]}</div><h2>${c.name}</h2><p>☎ ${c.phone}</p></div><div class="detail-metrics"><div>تعداد سفارش‌ها<b>${c.count}</b></div><div>آخرین سفارش<b>${c.last}</b></div></div><div class="detail-note">♥ ${c.note||"یادداشتی برای این مشتری ثبت نشده است."}</div><div class="detail-actions"><button>ویرایش</button><button>تماس</button></div>`}
$("#customerSearch").addEventListener("input",renderCustomers);
function openModal(which){$("#modalBackdrop").classList.add("open");$("#orderForm").classList.toggle("show",which==="order");$("#customerForm").classList.toggle("show",which==="customer")}
function closeModal(){$("#modalBackdrop").classList.remove("open");$$(".modal").forEach(m=>m.classList.remove("show"))}
$("#addOrderBtn").addEventListener("click",()=>openModal("order"));
$("#addCustomerBtn").addEventListener("click",()=>openModal("customer"));
$$("[data-new-order]").forEach(b=>b.addEventListener("click",()=>{openModal("order");$("#orderForm [name=type]").value=b.dataset.newOrder}));
$$("[data-close]").forEach(b=>b.addEventListener("click",closeModal));
$("#modalBackdrop").addEventListener("click",e=>{if(e.target.id==="modalBackdrop")closeModal()});
$("#orderForm").addEventListener("submit",e=>{e.preventDefault();const d=new FormData(e.target);orders.unshift({id:"۱۴۰۵-"+String(orders.length+22).padStart(3,"۰"),customer:d.get("customer"),type:d.get("type"),desc:d.get("description"),created:"۱۴۰۵/۰۸/۱۶",due:d.get("due")||"تعیین نشده",status:d.get("status"),price:+d.get("price")});renderOrders();renderUpcoming();closeModal();e.target.reset();go("orders");toast("سفارش جدید با موفقیت ثبت شد.")});
$("#customerForm").addEventListener("submit",e=>{e.preventDefault();const d=new FormData(e.target);customers.unshift({name:d.get("name"),phone:d.get("phone"),count:0,last:"—",state:"فعال",note:d.get("note")});renderCustomers();closeModal();e.target.reset();go("customers");toast("مشتری جدید اضافه شد.")});
$("#globalSearch").addEventListener("keydown",e=>{if(e.key==="Enter"){const q=e.target.value;go("orders");$("#orderSearch").value=q;renderOrders()}});
function renderUpcoming(){$("#upcomingList").innerHTML=orders.filter(o=>o.status!=="delivered").slice(0,3).map(o=>`<div class="upcoming-row"><span class="mini-avatar">${o.customer[0]}</span><div class="who"><b>${o.customer} – ${o.desc}</b><small>${statusText[o.status]}</small></div><span class="date-pill">${o.due.split("/").slice(-1)[0]} آبان</span></div>`).join("")}
renderOrders();renderCustomers();renderUpcoming();
