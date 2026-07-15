  setInterval(() => {
    const grid = document.querySelector('.framer-fbd1z7');
    if (grid && !document.querySelector('.casestudy-btn-injected')) {
      const buttonHtml = `<div class="casestudy-btn-injected framer-11slc2n-container" style="margin-top: 40px; display: flex; justify-content: center; width: 100%; position: relative; z-index: 999;"><a class="framer-7W2hy framer-HSXLe framer-1r2rpbk framer-v-1r2rpbk framer-wrl6m0" data-framer-name="Variant 1" target="_top" href="/casestudies"><div class="framer-12d9ns1" data-framer-component-type="RichTextContainer" style="--extracted-r6o4lv:var(--token-e374d95c-0883-47b0-9f7c-6ff189c778da, rgb(255, 255, 255));--framer-link-text-color:rgb(0, 153, 255);--framer-link-text-decoration:underline;transform:none"><p class="framer-text framer-styles-preset-hj0x3x" data-styles-preset="G4spYZp3J" style="--framer-text-color:var(--extracted-r6o4lv, var(--token-e374d95c-0883-47b0-9f7c-6ff189c778da, rgb(255, 255, 255)))">View all Case Studies</p></div><div data-framer-component-type="SVG" data-framer-name="Icon" parentsize="0" rotation="0" class="framer-1b8vfkj" aria-hidden="true" style="image-rendering:pixelated;flex-shrink:0;background-size:100% 100%;background-image:url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 xmlns:xlink=%22http://www.w3.org/1999/xlink%22 viewBox=%220 0 16 14%22><path d=%22M 15.206 7.331 L 9.581 12.956 C 9.398 13.139 9.102 13.139 8.919 12.956 C 8.736 12.773 8.736 12.477 8.919 12.294 L 13.743 7.469 L 1.125 7.469 C 0.866 7.469 0.656 7.259 0.656 7 C 0.656 6.741 0.866 6.531 1.125 6.531 L 13.743 6.531 L 8.919 1.706 C 8.755 1.52 8.764 1.239 8.939 1.064 C 9.114 0.889 9.395 0.88 9.581 1.044 L 15.206 6.669 C 15.388 6.852 15.388 7.148 15.206 7.331 Z%22 fill=%22rgb(255,255,255)%22></path></svg>')"></div></a></div>`;
      grid.insertAdjacentHTML('afterend', buttonHtml);
    }

    const contactLinks = document.querySelectorAll('a[href="#contact"]');
    contactLinks.forEach(contactLink => {
      const container = contactLink.parentElement;
      if (container && container.dataset.blogInjected !== "true") {
        container.dataset.blogInjected = "true";
        const newContainer = container.cloneNode(true);
        newContainer.classList.add('nav-blog-injected');
        const newLink = newContainer.querySelector('a');
        if (newLink) {
          newLink.setAttribute('href', '/blog');
          newLink.setAttribute('target', '_top');
          const walker = document.createTreeWalker(newLink, NodeFilter.SHOW_TEXT, null, false);
          let node;
          while (node = walker.nextNode()) {
            if (node.nodeValue.includes('Contact')) {
              node.nodeValue = node.nodeValue.replace('Contact', 'Blogs');
            }
          }
        }
        container.insertAdjacentElement('afterend', newContainer);
      }
    });
    contactLinks.forEach(contactLink => {
      const container = contactLink.parentElement;
      if (container && container.dataset.blogInjected === "true") {
        if (!container.nextElementSibling || !container.nextElementSibling.classList.contains('nav-blog-injected')) {
          container.dataset.blogInjected = "false";
        }
      }
    });
  }, 500);
