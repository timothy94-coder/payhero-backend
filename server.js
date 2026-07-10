import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());

const PORT = process.env.PORT || 5000;

const activeTransactions = new Map();
const statusThrottle = new Map();


app.get("/", (req, res) => {
  res.send("Backend alive (PayHero)");
});



app.post("/api/runPrompt", async (req, res) => {

  console.log("Incoming payment:", req.body);


  const {
    phone,
    amount,
    local_id,
    transaction_desc
  } = req.body;



  if (!phone || !amount || !local_id) {

    return res.status(400).json({
      status:false,
      message:"Missing required fields"
    });

  }



  if(activeTransactions.has(local_id)){

    return res.status(429).json({
      status:false,
      message:"Duplicate payment blocked"
    });

  }



  activeTransactions.set(local_id, Date.now());



  let formattedPhone =
    String(phone).replace(/\D/g,"");



  if(formattedPhone.startsWith("07")){

    formattedPhone =
      "254" + formattedPhone.slice(1);

  }



  if(!formattedPhone.startsWith("254")){

    activeTransactions.delete(local_id);

    return res.status(400).json({
      status:false,
      message:"Invalid phone number"
    });

  }





  try {


    console.log("PAYHERO CONFIG:", {

      has_auth:
      !!process.env.PAYHERO_BASIC_AUTH,

      account_id:
      process.env.PAYHERO_ACCOUNT_ID,

      channel_id:
      process.env.PAYHERO_CHANNEL_ID

    });




    const controller =
      new AbortController();


    const timeout =
      setTimeout(()=>{

        controller.abort();

      },90000);






    const payload = {


      phone_number:
      formattedPhone,


      amount:
      Number(amount),



      account_id:
      process.env.PAYHERO_ACCOUNT_ID,



      channel_id:
      process.env.PAYHERO_CHANNEL_ID,



      provider:
      "m-pesa",



      external_reference:
      local_id,



      customer_name:
      transaction_desc || "Customer",



      description:
      transaction_desc || "Payment",



      callback_url:
      process.env.PAYHERO_CALLBACK_URL

    };



    console.log("PAYHERO REQUEST:", payload);




    const response = await fetch(
  "https://backend.payhero.co.ke/api/v2/payments",
  {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "Authorization":
        `Basic ${process.env.PAYHERO_BASIC_AUTH}`
    },

    body: JSON.stringify(payload),

    signal: controller.signal
  }
);

    clearTimeout(timeout);




    const rawText =
      await response.text();



    let data;



    try {

      data =
      JSON.parse(rawText);

    }

    catch {

      data = {
        raw:rawText
      };

    }




    console.log(
      "PAYHERO RESPONSE:",
      data
    );





    if(!response.ok){


      activeTransactions.delete(local_id);



      return res.status(response.status).json({

        status:false,

        message:
        data.error_message ||
        data.message ||
        "PayHero failed",


        data

      });


    }





    res.json({

      status:true,

      message:
      "STK Push sent",


      data

    });




  }

  catch(err){


    console.error(
      "PAYMENT ERROR:",
      err
    );



    activeTransactions.delete(local_id);



    res.status(500).json({

      status:false,

      message:
      "Payment server error",

      error:
      err.message

    });


  }


});







app.post(
"/api/payhero-callback",
(req,res)=>{


console.log(
"PAYHERO CALLBACK:",
JSON.stringify(req.body,null,2)
);



if(req.body.status === "success"){

console.log(
"PAYMENT SUCCESS"
);


}else{


console.log(
"PAYMENT FAILED"
);


}



res.sendStatus(200);


});









app.get(
"/api/status/:id",
async(req,res)=>{


const id =
req.params.id;



const now =
Date.now();



const last =
statusThrottle.get(id);



if(last && now-last < 5000){

return res.status(429).json({

message:
"Slow down"

});

}



statusThrottle.set(id,now);





try{


const response =
await fetch(

`https://backend.payhero.co.ke/api/v2/transaction/${id}`,

{


headers:{


Authorization:

`Basic ${process.env.PAYHERO_BASIC_AUTH}`


}


}

);



const data =
await response.json();



res.json(data);



}

catch(err){


console.error(err);



res.status(500).json({

message:
"Status check failed"

});


}



});









setInterval(()=>{


const now =
Date.now();



for(const [key,time]
of activeTransactions.entries()){



if(now-time >
10*60*1000){


activeTransactions.delete(key);


}


}



},60000);







process.on(
"uncaughtException",
(err)=>{

console.error(
"Crash:",
err
);

});



process.on(
"unhandledRejection",
(err)=>{

console.error(
"Promise error:",
err
);

});







app.listen(PORT,()=>{


console.log(
`PayHero backend running on ${PORT}`
);


});
