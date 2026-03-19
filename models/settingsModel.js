const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  url: { type: String, required: true },
});

const featureSchema = new mongoose.Schema({
  icon: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true }
});

const faqSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true }
});

const settingsSchema = new mongoose.Schema({
  termsOfService: { type: String, required: true, default: 'Your terms of service go here...' },
  privacyPolicy: { 
    type: String, 
    required: true, 
    default: `
## Privacy Policy

We value your privacy and are committed to safeguarding the personal information you share with us. This Privacy Policy explains how we collect, use, and protect your data when you interact with our website and services.

---

### Types of Personal Information Collected and Stored

1.1. We collect the following personal information when you use third-party login services or create an account on our website:
- Account ID (from third-party login services such as Discord, GitHub, Google, etc.)
- Email address
- User profile information (such as profile picture/avatar, guilds, etc.)
- Internet Protocol (IP) address
- Payment details (For PayPal, we collect your account handle/email; for Stripe, we collect the last 4 digits of your card and transaction details; for Coinbase, we collect transaction details, including the payment method used, the transaction amount, and the cryptocurrency involved.)

1.2. We use login services through platforms such as Discord, GitHub, Google, and Twitter. These platforms provide basic information via their respective APIs. Please refer to their privacy policies for further details on how they handle your data.

---

### Information Collection Process

2.1. When you log in and create an account, your personal information is securely collected and stored in our database. Payment information is only collected when a purchase is made on our website.

---

### Use of Your Information

3.1. We use the information we collect for the following purposes:
- Managing your account and providing related services
- Maintaining administrative records, including payment history and receipts
- Collecting aggregated data for advertising and performance analysis, which does not identify individual users

---

### Information Sharing

4.1. We do not sell, trade, or disclose your personal information to third parties, except as necessary for the operation of our services or as required by law.

---

### Information Security

5.1. We take appropriate measures to ensure the security of your personal information. This includes using industry-standard security protocols to prevent unauthorized access, disclosure, alteration, or destruction of your data.

---

### Data Retention

6.1. We retain your personal information for as long as necessary to fulfill the purposes outlined in this Privacy Policy, or as required or permitted by law.

---

### Third-Party Links

7.1. Our website may contain links to third-party websites or services. We are not responsible for the privacy practices of these third parties. We encourage you to review the privacy policies of any third-party websites you visit.

---

### Your Rights and Choices

8.1. You have the right to access, update, or correct inaccuracies in your personal information. You may also request the deletion of your personal information, subject to legal requirements.

8.2. If you have any questions or concerns regarding your personal information or this Privacy Policy, please contact us using the information provided below.

---

### Changes to This Privacy Policy

9.1. We may update this Privacy Policy periodically to reflect changes in our practices or legal obligations. Any significant changes will be communicated by posting a prominent notice on our website or via other communication methods.

---

**Please review this Privacy Policy carefully. By continuing to use our services, you consent to the collection, use, and storage of your personal information as described in this policy.**
`
  },
  aboutUsText: { type: String, required: true, default: 'Your about us text goes here...' },
  aboutUsVisible: { type: Boolean, required: true, default: true },
  displayStats: { type: Boolean, required: true, default: true },
  displayFeatures: { type: Boolean, required: true, default: true },
  displayReviews: { type: Boolean, required: true, default: true },
  displayProductReviews: { type: Boolean, required: true, default: true },
  showProductStats: { type: Boolean, required: true, default: false },
  displayCTABanner: { type: Boolean, required: true, default: true },
  displayFAQ: { type: Boolean, default: false },
  faqs: [faqSchema],
  features: [featureSchema],
  logoPath: { type: String, default: '/images/logo.png' },
  websiteFont: { type: String, default: 'Rubik' },
  faviconPath: { type: String, default: '/images/favicon.ico' },
  accentColor: { type: String, default: '#E50914' },
  discordInviteLink: { type: String, default: '' },
  siteBannerText: { type: String, default: '' },
  homePageTitle: { type: String, default: 'NETFLIX PREMIUM' },
  homePageSubtitle: { type: String, default: 'Trải nghiệm xem phim bản quyền với chất lượng 4K Ultra HD và âm thanh vòm Dolby Atmos. Cung cấp tài khoản Netflix Premium chất lượng cao với giá ưu đãi nhất thị trường.' },
  productsPageTitle: { type: String, default: 'Dịch Vụ Của Chúng Tôi' },
  productsPageSubtitle: { type: String, default: 'Lựa chọn gói dịch vụ phù hợp với nhu cầu của bạn.' },
  tosPageTitle: { type: String, default: 'Điều Khoản Dịch Vụ' },
  tosPageSubtitle: { type: String, default: 'Vui lòng đọc kỹ điều khoản dịch vụ trước khi sử dụng sản phẩm và dịch vụ của chúng tôi.' },
  privacyPolicyPageTitle: { type: String, default: 'Chính Sách Bảo Mật' },
  privacyPolicyPageSubtitle: { type: String, default: 'Tìm hiểu cách chúng tôi thu thập, sử dụng và bảo vệ thông tin cá nhân của bạn.' },
  storeName: { type: String, default: 'NETFLIX COLDBREW' },
  paymentCurrency: { type: String, default: 'VND' },
  currencySymbol: { type: String, default: '₫' },
  customNavTabs: [{ name: { type: String, required: true }, link: { type: String, required: true } }],
  customFooterTabs: [{ name: { type: String, required: true }, link: { type: String, required: true } }],
  footerDescription: { type: String, required: true, default: 'Cung cấp tài khoản Netflix Premium chất lượng cao với giá ưu đãi nhất thị trường. Trải nghiệm giải trí không giới hạn.' },
  features: [
    { icon: { type: String, required: true, default: 'fas fa-user-friends' }, title: { type: String, required: true, default: 'User-Friendly' }, description: { type: String, required: true, default: 'Easily manage your store with our intuitive interface, no coding required.' }},
    { icon: { type: String, required: true, default: 'fas fa-cogs' }, title: { type: String, required: true, default: 'Highly Customizable' }, description: { type: String, required: true, default: 'Tailor your store to match your brand with extensive customization options.' }},
    { icon: { type: String, required: true, default: 'fas fa-shield-alt' }, title: { type: String, required: true, default: 'Secure' }, description: { type: String, required: true, default: 'Keep your store and customer data safe with our built-in security features.' }}
  ],
  seoTitle: { type: String, default: 'NETFLIX COLDBREW - Tài Khoản Netflix Premium Giá Rẻ, Chất Lượng Cao' },
  seoDescription: { type: String, default: 'NETFLIX COLDBREW cung cấp tài khoản Netflix Premium chất lượng 4K Ultra HD, âm thanh Dolby Atmos với giá ưu đãi nhất. Bảo hành, hỗ trợ 24/7.' },
  seoTags: { type: String, default: 'Netflix Premium, Netflix giá rẻ, tài khoản Netflix, Netflix 4K, Netflix Coldbrew, mua Netflix, Netflix Việt Nam' },
  apiKey: { type: String, default: '' },
  apiEnabled: { type: Boolean, default: false },
  antiPiracyEnabled: { type: Boolean, default: false },
  salesTax: { type: Number, default: 0 },
  discordLoggingChannel: { type: String, default: '' },
  productCategories: [categorySchema],
  sendReviewsToDiscord: { type: Boolean, default: false },
  discordReviewChannel: { type: String, default: '' },
  minimumReviewLength: { type: Number, default: 30 },
  allowReviewDeletion: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
  systemConfig: { type: String, default: '{{IDENTIFIER}}', required: false },
  tosLastUpdated: { type: Date, default: Date.now },
  privacyPolicyLastUpdated: { type: Date, default: Date.now },
  saleEventEnabled: { type: Boolean, default: false },
  saleEventType: { type: String, enum: ['black-friday', 'christmas', 'easter', 'new-year', 'summer', 'halloween', 'valentines', 'cyber-monday'], default: null  },
  saleEventMessage: { type: String, default: '' },
  holidayEffectsEnabled: { type: Boolean, default: false },
  holidayEffectsType: { type: String, enum: ['christmas', 'halloween', 'valentines', 'new-year', 'easter', 'black-friday'], default: null },
  socialLinks: {
  discord: { type: String, default: '' },
  twitter: { type: String, default: '' },
  instagram: { type: String, default: '' },
  youtube: { type: String, default: '' },
  github: { type: String, default: '' },
  tiktok: { type: String, default: '' },
  linkedin: { type: String, default: '' },
  facebook: { type: String, default: '' }
},
  displaySocialLinks: { type: Boolean, default: true },
    emailSettings: {
    enabled: { type: Boolean, default: false },
    fromEmail: { type: String, default: '' },
    provider: { type: String, enum: ['sendgrid', 'smtp'], default: 'smtp' },
    sendGrid: {
      token: { type: String, default: '' }
    },
    smtp: {
      host: { type: String, default: '' },
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false },
      user: { type: String, default: '' },
      password: { type: String, default: '' }
    }
  },
  paymentMethods: {
    paypal: {
      enabled: { type: Boolean, default: false },
      accountType: { type: String, enum: ['business', 'personal'], default: 'business' },
      mode: { type: String, enum: ['sandbox', 'live'], default: 'sandbox' },
      clientId: { type: String, default: '' },
      clientSecret: { type: String, default: '' },
      personalEmail: { type: String, default: '' }
  },
    stripe: {
      enabled: { type: Boolean, default: false },
      secretKey: { type: String, default: '' }
  },
    coinbase: {
      enabled: { type: Boolean, default: false },
      apiKey: { type: String, default: '' },
      webhookSecret: { type: String, default: '' }
  },
    vietqr: {
      enabled: { type: Boolean, default: false },
      bankCode: { type: String, default: '970405' },
      accountNumber: { type: String, default: '' },
      accountName: { type: String, default: '' },
      accountType: { type: Number, default: 0 },
      clientId: { type: String, default: '' },
      apiKey: { type: String, default: '' },
      sepayApiToken: { type: String, default: '' }, // SePay API Token for auto-verify
      webhookUrl: { type: String, default: '' },
      webhookSecret: { type: String, default: '' },
      autoConfirmTimeout: { type: Number, default: 300000 }
  }
}
});


settingsSchema.pre('save', function (next) {
  if (this.isNew && (!this.features || this.features.length === 0)) {
    this.features = [
      {
        icon: 'fas fa-rocket',
        title: 'Lightning Fast',
        description: 'Experience blazing-fast performance with our optimized solutions designed for speed and efficiency.'
      },
      {
        icon: 'fas fa-shield-alt',
        title: 'Secure & Reliable',
        description: 'Your data and transactions are protected with enterprise-grade security and 99.9% uptime guarantee.'
      },
      {
        icon: 'fas fa-headset',
        title: '24/7 Support',
        description: 'Our dedicated support team is always available to help you succeed with friendly, expert assistance.'
      }
    ];
  }

  this.updatedAt = Date.now();
  next();
});

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings;
