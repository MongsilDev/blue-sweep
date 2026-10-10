// 외부 요청 없는 순수 함수라 브라우저와 node 공용
(function (root) {
  const RX = {
    tesla: /테슬라|일론|머스크|사이버트럭|옵티머스|로보택시|tesla|tsla|(^|[^a-z])(fsd|elon|musk)([^a-z]|$)|cybertruck|robotaxi/u,
    teslaFan: /tsla|fsd|테슬람|테슬라(를)? ?(사랑|투자|주주|몰빵|팬)|fan of tesla|tesla (fan|investor|bull|shareholder|creator|advocate)/u,
    monet: /수익 ?(창출|화|인증|정산|공개)|수제트|정직원|주급|파딱|맞팔|선팔|실버버튼|팔로우 ?(해 ?주|하면|하시면|부탁|제한)|creator revenue|monetiz|payout|follow ?back|follow (me )?for more/u,
    // 본문에서는 흔한 말이라 bio에서만 검사
    growthBio: /grew my|x views|impressions/u,
    aiHype: /ai (tools|tips|news|guides|agents|automation|creator|influencer|educator|trends?)|free ai|ai[.] before|tech \/ ai|sharing (ai|tips|prompts)|helping (you|builders|founders|creators)|follow (to|for) |(prompts|guides|tips|tools)[^|]{0,30}(daily|every day)|ai ?(소식|트렌드|정보|뉴스|활용|툴|꿀팁)|ai 크리에이터|프롬프트|매일 (공유|정리)|소식 ?(전해|전달|공유)/u,
    topic: /부업|경제적 자유|재테크|투자|주식|코인|비트코인|트레이딩|테크 소식|바이브 ?코딩|1인 ?(제작|기업|창업|개발)|자동화|(^|[^a-z])ai([^a-z]|$)|llm|gpt|vibe ?cod|invest|trader|trading|crypto|bitcoin|web3|암호화폐|가상화폐|이더리움|솔라나|알트코인|밈코인|에어드랍|바이낸스|업비트|altcoin|memecoin|airdrop|binance|bybit|(^|[^a-z])(nfts?|defi|xrp|doge(coin)?)([^a-z]|$)|\$[a-z]{2,5}([^a-z]|$)|(^|[^a-z])(btc|eth|sol)([^a-z]|$)|build(ing)? in public|indie ?hacker|solopreneur|grok|prompt|side hustle|passive income|ghostwrit|tech news|이슈|트렌드|꿀팁|알파/u,
    promo: /광고|협찬|스폰|sponsor|collab|promo/u,
    bait: /여러분이라면|여러분은 어떻게|어떻게 생각하(세요|시나요|십니까)|다들 어떠(세요|신가요)|다들 어떻게|(리트윗|알티) ?(해 ?주|하면|부탁)|북마크 ?(해 ?두|필수|하세요)|저장해 ?두세요|(스레드|타래)로 정리|like (and|&|&amp;|[+]) (rt|retweet|repost)|(rt|retweet|repost|like) if you|bookmark this|save this (for later|post|thread)|🧵|let that sink in|(nobody|no one) is talking about|you won.?t believe|hot take:|unpopular opinion|thoughts[?]|agree[?]|what do you think[?]|(comment|reply) .{1,30} and i.?ll (send|dm)|[0-9]+ (ai )?(prompts|tools|ways|lessons|tips|websites) |passive income|make money online|side hustle|is (f\S{0,6}ing )?(insane|wild|crazy)|just dropped|drop this in|this changes everything|game.?changer|mind.?blowing|🤯|thank me later|it.?s (f\S{0,6}ing )?(insane|wild|crazy|unreal)|full guide/u,
  };

  // user: { followers, following, statuses, media, createdAt, bio, name, screenName }
  function classify(user, text, now) {
    const days = Math.max(1, (now - Date.parse(user.createdAt)) / 864e5);
    const rate = user.statuses / days;
    const mediaRatio = user.statuses > 0 ? (user.media || 0) / user.statuses : 0;
    const bio = (user.bio || '').toLowerCase().replace(/(🚫|no |not |anti[- ]?)ai/g, ' ');
    const names = ((user.name || '') + ' ' + (user.screenName || '')).toLowerCase();
    const bioAndText = bio + '\n' + (text || '').toLowerCase();
    const mutual = user.following >= 500 && user.following * 3 > user.followers;

    let score = 0, signal = false;
    const why = [];
    const add = (points, reason) => { score += points; why.push(reason); };
    // 계정 수치만으로는 차단하지 않도록 내용 신호를 따로 표시
    const addSignal = (points, reason) => { add(points, reason); signal = true; };

    if (mutual) add(2, '맞팔');
    if (days < 180) add(2, '신생'); else if (days < 730) add(1, '2년미만');
    if (rate >= 80) add(4, '초다작'); else if (rate >= 20) add(2, '다작'); else if (rate >= 5) add(1, '활발');
    if (user.statuses >= 200 && mediaRatio < 0.15) add(1, '텍스트');

    if (RX.monet.test(bioAndText) || RX.growthBio.test(bio)) addSignal(3, '수익화');
    // 머스크 본인처럼 이름이 걸리는 대형 계정 제외
    const teslaName = user.followers < 1000000 && RX.tesla.test(names);
    if (teslaName || RX.tesla.test(bio)) {
      addSignal(4, '테슬라');
      if (teslaName || RX.teslaFan.test(bio)) add(2, '팬');
    }
    if (RX.aiHype.test(bio)) addSignal(3, 'AI 정보'); else if (RX.topic.test(bio)) addSignal(2, '주제');
    if (RX.promo.test(bio)) addSignal(1, '광고문의');
    if (RX.bait.test(bioAndText)) addSignal(2, '낚시');

    return { score, why, signal, mutual, active: rate >= 5 };
  }

  const api = { classify, RX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__blueSweep = api;
})(typeof window !== 'undefined' ? window : globalThis);
