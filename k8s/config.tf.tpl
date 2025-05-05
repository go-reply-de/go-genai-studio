version: 1.0.8
cache: true
fileStrategy: gcs
interface:
  privacyPolicy:
    externalUrl: https://www.reply.com/en/privacy-policy
    openNewTab: true
  termsOfService:
    externalUrl: https://${app_domain}/tos
    openNewTab: true
    modalAcceptance: true
    modalTitle: Terms of Service for ${app_name}
    modalContent: >
      # Terms and Conditions for ${app_name}


      *Effective Date: ${date}*


      Welcome to ${app_name}, a powerful AI-powered platform that simplifies the creation of engaging and personalized chat experiences, available at https://${app_domain}.

      Whether you're building a chatbot for customer service, marketing, or entertainment, Go GenAI Studio provides a user-friendly interface and advanced AI features to help you design and deploy your chatbot with ease.
      
      These Terms of Service ("Terms") govern your use of our website and the services we offer. By accessing or using the Website, you agree to be bound by these Terms and our Privacy Policy, accessible at https://www.reply.com/en/privacy-policy.


      ## 1. Ownership


      Upon purchasing a package from GO Reply, you are granted the right to download and use the code for accessing an admin panel for ${app_name}. While you own the downloaded code, you are expressly prohibited from reselling, redistributing, or otherwise transferring the code to third parties without explicit permission from GO Reply.


      ## 2. User Data


      We collect personal data, such as your name, email address, and payment information, as described in our Privacy Policy. This information is collected to provide and improve our services, process transactions, and communicate with you.


      ## 3. Non-Personal Data Collection


      The Website uses cookies to enhance user experience, analyze site usage, and facilitate certain functionalities. By using the Website, you consent to the use of cookies in accordance with our Privacy Policy.


      ## 4. Use of the Website


      You agree to use the Website only for lawful purposes and in a manner that does not infringe the rights of, restrict, or inhibit anyone else's use and enjoyment of the Website. Prohibited behavior includes harassing or causing distress or inconvenience to any person, transmitting obscene or offensive content, or disrupting the normal flow of dialogue within the Website.


      ## 5. Governing Law


      These Terms shall be governed by and construed in accordance with the laws of Germany, without giving effect to any principles of conflicts of law.


      ## 6. Changes to the Terms


      We reserve the right to modify these Terms at any time. We will notify users of any changes by email. Your continued use of the Website after such changes have been notified will constitute your consent to such changes.


      ## 7. Contact Information


      If you have any questions about these Terms, please contact us at ${email}


      By using the Website, you acknowledge that you have read these Terms of Service and agree to be bound by them.
registration:
  socialLogins: ["google"]
  allowedDomains:
  %{ for domain in allowed_domains ~}
    - ${domain}
  %{ endfor ~}