const fs = require('fs');
const yaml = require("js-yaml")
const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));
const axios = require('axios');
const color = require('ansi-colors');
const botVersion = require('./package.json');
const path = require('path');

console.log(`${color.yellow(`Starting product, this can take a while..`)}`)

const version = Number(process.version.split('.')[0].replace('v', ''));
if (version < 20) {
  console.log(`${color.red(`[ERROR] NETFLIX COLDBREW Store requires a NodeJS version of 20 or higher!\nYou can check your NodeJS by running the "node -v" command in your terminal.`)}`);


  console.log(`${color.blue(`\n[INFO] To update Node.js, follow the instructions below for your operating system:`)}`);
  console.log(`${color.green(`- Windows:`)} Download and run the installer from ${color.cyan(`https://nodejs.org/`)}`);
  console.log(`${color.green(`- Ubuntu/Debian:`)} Run the following commands in the Terminal:`);
  console.log(`${color.cyan(`  - sudo apt update`)}`);
  console.log(`${color.cyan(`  - sudo apt upgrade nodejs`)}`);
  console.log(`${color.green(`- CentOS:`)} Run the following commands in the Terminal:`);
  console.log(`${color.cyan(`  - sudo yum update`)}`);
  console.log(`${color.cyan(`  - sudo yum install -y nodejs`)}`);

  let logMsg = `\n\n[${new Date().toLocaleString()}] [ERROR] NETFLIX COLDBREW Store requires a NodeJS version of 20 or higher!`;
  fs.appendFile("./logs.txt", logMsg, (e) => { 
    if(e) console.log(e);
  });

  process.exit()
}

const { Collection, Client, Discord, ActionRowBuilder, ButtonBuilder, GatewayIntentBits } = require('discord.js');
const client = new Client({ 
  restRequestTimeout: 60000,
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildPresences, 
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ] 
});
exports.client = client;


require("./app.js");

async function uploadToHaste(textToUpload) {
    try {
      // Log saved locally in logs.txt
      return null;
    } catch (error) {
      return null;
    }
  }
  
  const filePath = './logs.txt';
  const maxLength = 300;
  
  async function handleAndUploadError(errorType, error) {
    console.log(error);
  
    const errorPrefix = `[${new Date().toLocaleString()}] [${errorType}] [v${botVersion.version}]`;
    const errorMsg = `\n\n${errorPrefix}\n${error.stack}`;
    fs.appendFile("./logs.txt", errorMsg, (e) => {
      if (e) console.log(e);
    });
  
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        console.error('Error reading file:', err.message);
        return;
      }
  
      const lines = data.split('\n');
      const truncatedContent = lines.length > maxLength ? lines.slice(-maxLength).join('\n') : data;
  
      uploadToHaste(truncatedContent).then(key => {
        if (key) {
          console.log(`${color.green.bold(`[v${botVersion.version}]`)} ${color.red(`Error logged. Check logs.txt for details.`)}\n\n`);
        } else {
          console.log(`${color.green.bold(`[v${botVersion.version}]`)} ${color.red(`Error logged. Check logs.txt for details.`)}`);
        }
      });
    });
  }
  
  const os = require('os');

  const productModel = require('./models/productModel')
  const settingsModel = require('./models/settingsModel')
  const statisticsModel = require('./models/statisticsModel')
  const DiscountCodeModel = require('./models/discountCodeModel')

  async function generateDebugInfo() {
    try {
        const debugInfo = {
          timestamp: new Date().toISOString(),
          nodeVersion: process.version,
          productVersion: botVersion.version,
          platform: os.platform(),
          platformVersion: os.release(),
          architecture: os.arch(),
          memoryUsage: process.memoryUsage(),
          uptime: process.uptime(),
          workingDirectory: process.cwd(),
          appPath: path.resolve(__dirname),
          userInfo: os.userInfo(),
          systemUptime: os.uptime(),
          configData: {
              OwnerID: config.OwnerID,
              callbackURL: config.callbackURL,
              Secure: config.Secure,
              trustProxy: config.trustProxy,
              SessionExpires: config.SessionExpires,
              baseURL: config.baseURL,
              Port: config.Port
          },
      };

        const [products, discounts, settings, statistics] = await Promise.all([
            productModel.find().lean(),
            DiscountCodeModel.find().lean(),
            settingsModel.find().lean(),
            statisticsModel.find().lean(),
        ]);

        debugInfo.mongoData = {
            products,
            discounts,
            settings,
            statistics,
        };

        const debugContent = JSON.stringify(debugInfo, null, 2);
        const debugFilePath = path.join(__dirname, 'uploads', `debug-${Date.now()}.json`);

      console.log(color.red.bold('[DEBUG MODE ENABLED]'));
      console.log(color.yellow(
        '⚠️  Debug Mode is intended for development only.\n' +
        'Some features (including payments and callbacks) may be disabled or behave differently.\n' +
        'Turn this off immediately on any live store.'
      ));
      console.log(color.yellow('You will now see more detailed errors and debug information.'));

        fs.writeFileSync(debugFilePath, debugContent, 'utf-8');
        console.log(color.blue.bold('Debug information generated at:'), color.cyan(debugFilePath));

        const pasteKey = await uploadToHaste(debugContent);
        if (pasteKey) {
            console.log(color.green.bold('\n\n[DEBUG]'), 'Debug information saved successfully!');
            console.log(color.yellow.bold('Debug file saved at:'), color.cyan(debugFilePath), '\n\n');
        } else {
            console.log(color.green.bold('\n\n[DEBUG]'), 'Debug information saved locally.');
            console.log(color.yellow.bold('Debug file saved at:'), color.cyan(debugFilePath), '\n\n');
        }
    } catch (error) {
        console.error(color.red.bold('Error generating debug information:'), error);
    }
}

if (config.DebugMode) {
    generateDebugInfo();
}

  process.on('warn', async (error) => {
    handleAndUploadError('WARN', error);
  });
  
  process.on('error', async (error) => {
    handleAndUploadError('ERROR', error);
  });
  
  process.on('unhandledRejection', async (error) => {
    handleAndUploadError('unhandledRejection', error);
  });
  
  process.on('uncaughtException', async (error) => {
    handleAndUploadError('uncaughtException', error);
  });

  client.on('ready', async () => {
    console.log(color.yellow("[DISCORD BOT] ") + `Discord bot has logged in.`)

    let guild = await client.guilds.cache.get(config.GuildID)
    if(!guild) {
        await console.log('\x1b[31m%s\x1b[0m', `[ERROR] The guild ID specified in the config is invalid or the bot is not in the server!\nYou can use the link below to invite the bot to your server:\nhttps://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`)
        //await process.exit()
    }

  });


  client.login(config.Token).catch(error => {
    if (error.message.includes("Used disallowed intents")) {
      console.log('\x1b[31m%s\x1b[0m', `Used disallowed intents (READ HOW TO FIX): \n\nYou did not enable Privileged Gateway Intents in the Discord Developer Portal!\nTo fix this, you have to enable all the privileged gateway intents in your discord developer portal, you can do this by opening the discord developer portal, go to your application, click on bot on the left side, scroll down and enable Presence Intent, Server Members Intent, and Message Content Intent`);
    } else if (error.message.includes("An invalid token was provided")) {
      console.log('\x1b[31m%s\x1b[0m', `[ERROR] The bot token specified in the config is incorrect!`)
    } else {
      console.log('\x1b[31m%s\x1b[0m', `[ERROR] An error occured while attempting to login to the bot`)
      console.log(error)
    }
  })
