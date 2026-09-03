<?php
$file = 'd:/phpstudy_pro/WWW/jingtu-web/public/index.html';
$content = file_get_contents($file);

$langScripts = '
<script src="/js/languages/zh.js"></script>
<script src="/js/languages/en.js"></script>
<script src="/js/languages/ja.js"></script>
<script src="/js/languages/de.js"></script>
<script src="/js/languages/fr.js"></script>
<script src="/js/languages/ru.js"></script>';

$content = str_replace('<script src="/js/core.js" defer></script>', $langScripts . "\n<script src=\"/js/core.js\" defer></script>", $content);

file_put_contents($file, $content);
echo "Done!\n";
