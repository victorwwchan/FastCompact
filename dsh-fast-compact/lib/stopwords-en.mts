/**
 * dsh-fast-compact — English stopwords for the YAKE port (lib/yake.mts).
 *
 * Trimmed from the official INESCTEC/yake StopwordsList/stopwords_en.txt (581
 * entries) down to the function words that matter for agent messages: the
 * paper-acronym noise of the original list ("co", "edu", "inc", "nd", "sub"…)
 * and the lone-letter rows were dropped, since in code text a lone letter is
 * handled by yake.mts' own length rule and acronym tokens are signal, not noise.
 *
 * @module dsh-fast-compact/lib/stopwords-en
 */

export const EN_STOPWORDS: readonly string[] = [
  'a', "a's", 'able', 'about', 'above', 'across', 'after', 'afterwards', 'again', 'against',
  "ain't", 'all', 'allow', 'allows', 'almost', 'alone', 'along', 'already', 'also',
  'although', 'always', 'am', 'among', 'amongst', 'an', 'and', 'another', 'any', 'anybody',
  'anyone', 'anything', 'anyway', 'anywhere', 'apart', 'appear', 'are', "aren't", 'around',
  'as', 'ask', 'asking', 'at', 'available', 'away', 'be', 'became', 'because', 'become',
  'becomes', 'becoming', 'been', 'before', 'behind', 'being', 'below', 'beside', 'besides',
  'best', 'better', 'between', 'beyond', 'both', 'brief', 'but', 'by', 'came', 'can',
  "can't", 'cannot', 'cant', 'come', 'comes', 'could', "couldn't", 'course', 'currently',
  'definitely', 'described', 'despite', 'did', "didn't", 'different', 'do', 'does',
  "doesn't", 'doing', "don't", 'done', 'down', 'during', 'each', 'eight', 'either', 'else',
  'elsewhere', 'enough', 'entirely', 'especially', 'even', 'ever', 'every', 'everybody',
  'everyone', 'everything', 'everywhere', 'exactly', 'except', 'far', 'few', 'fifth',
  'first', 'five', 'followed', 'following', 'follows', 'for', 'former', 'formerly', 'four',
  'from', 'further', 'get', 'gets', 'getting', 'given', 'gives', 'go', 'goes', 'going',
  'gone', 'got', 'gotten', 'had', "hadn't", 'happens', 'hardly', 'has', "hasn't", 'have',
  "haven't", 'having', 'he', "he's", 'her', 'here', "here's", 'hers', 'herself', 'hi',
  'him', 'himself', 'his', 'hopefully', 'how', 'however', 'i', "i'd", "i'll", "i'm", "i've",
  'if', 'in', 'into', 'is', "isn't", 'it', "it'd", "it'll", "it's", 'its', 'itself', 'just',
  'keep', 'keeps', 'kept', 'know', 'knows', 'known', 'last', 'lately', 'later', 'latter',
  'least', 'less', 'lest', 'let', "let's", 'like', 'liked', 'likely', 'little', 'look',
  'looking', 'looks', 'mainly', 'many', 'may', 'maybe', 'me', 'mean', 'meanwhile', 'merely',
  'might', 'more', 'moreover', 'most', 'mostly', 'much', 'must', 'my', 'myself', 'name',
  'near', 'nearly', 'need', 'needs', 'neither', 'never', 'nevertheless', 'new', 'next',
  'nine', 'no', 'nobody', 'none', 'noone', 'nor', 'normally', 'not', 'nothing', 'novel',
  'now', 'nowhere', 'obviously', 'of', 'off', 'often', 'oh', 'ok', 'okay', 'old', 'on',
  'once', 'one', 'ones', 'only', 'onto', 'or', 'other', 'others', 'otherwise', 'ought',
  'our', 'ours', 'ourselves', 'out', 'outside', 'over', 'overall', 'own', 'particular',
  'particularly', 'perhaps', 'placed', 'please', 'plus', 'possible', 'presumably',
  'probably', 'provides', 'quite', 'rather', 'really', 'reasonably', 'regarding',
  'regardless', 'relatively', 'respectively', 'right', 'said', 'same', 'saw', 'say',
  'saying', 'says', 'second', 'secondly', 'see', 'seeing', 'seem', 'seemed', 'seeming',
  'seems', 'seen', 'self', 'selves', 'sensible', 'sent', 'serious', 'seriously', 'seven',
  'several', 'shall', 'she', 'should', "shouldn't", 'since', 'six', 'so', 'some',
  'somebody', 'someone', 'something', 'sometimes', 'somewhat', 'somewhere', 'soon', 'sorry',
  'specified', 'specify', 'specifying', 'still', 'sub', 'such', 'sure', 'take', 'taken',
  'tell', 'tends', 'than', 'thank', 'thanks', 'that', "that's", 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'hence', 'there', "there's", 'therefore', 'theres',
  'these', 'they', "they'd", "they'll", "they're", "they've", 'think', 'third', 'this',
  'thorough', 'thoroughly', 'those', 'though', 'three', 'through', 'throughout', 'thru',
  'thus', 'to', 'together', 'too', 'took', 'toward', 'towards', 'tried', 'tries', 'truly',
  'try', 'trying', 'twice', 'two', 'under', 'unfortunately', 'unless', 'unlikely', 'until',
  'unto', 'up', 'upon', 'us', 'use', 'used', 'useful', 'uses', 'using', 'usually', 'value',
  'various', 'very', 'via', 'was', "wasn't", 'way', 'we', "we'd", "we'll", "we're", "we've",
  'welcome', 'well', 'went', 'were', "weren't", 'what', "what's", 'whatever', 'when',
  'whence', 'whenever', 'where', "where's", 'whereafter', 'whereas', 'whereby', 'wherein',
  'whereupon', 'wherever', 'whether', 'which', 'while', 'whither', 'who', "who's",
  'whoever', 'whole', 'whom', 'whose', 'why', 'will', 'willing', 'wish', 'with', 'within',
  'without', "won't", 'wonder', 'would', "wouldn't", 'yes', 'yet', 'you', "you'd", "you'll",
  "you're", "you've", 'your', 'yours', 'yourself', 'yourselves', 'zero',
];
