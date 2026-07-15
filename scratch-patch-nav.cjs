const fs = require('fs');

let indexHtml = fs.readFileSync('dist/index.html', 'utf8');

const navJsFix = `\n<script>\n  setInterval(() => {\n    const contactLinks = document.querySelectorAll('a[href="#contact"]');\n    contactLinks.forEach(contactLink => {\n      const container = contactLink.parentElement;\n      if (container && container.dataset.blogInjected !== "true") {\n        container.dataset.blogInjected = "true";\n        const newContainer = container.cloneNode(true);\n        newContainer.classList.add('nav-blog-injected');\n        const newLink = newContainer.querySelector('a');\n        if (newLink) {\n          newLink.setAttribute('href', '/blog');\n          newLink.setAttribute('target', '_top');\n          const walker = document.createTreeWalker(newLink, NodeFilter.SHOW_TEXT, null, false);\n          let node;\n          while (node = walker.nextNode()) {\n            if (node.nodeValue.includes('Contact')) {\n              node.nodeValue = node.nodeValue.replace('Contact', 'Blogs');\n            }\n          }\n        }\n        container.insertAdjacentElement('afterend', newContainer);\n      }\n    });\n    contactLinks.forEach(contactLink => {\n      const container = contactLink.parentElement;\n      if (container && container.dataset.blogInjected === "true") {\n        if (!container.nextElementSibling || !container.nextElementSibling.classList.contains('nav-blog-injected')) {\n          container.dataset.blogInjected = "false";\n        }\n      }\n    });\n  }, 500);\n</script>\n`;

// Append to the end of the body
indexHtml = indexHtml.replace('</body>', navJsFix + '</body>');
fs.writeFileSync('dist/test-nav.html', indexHtml);
console.log('Test file written.');
