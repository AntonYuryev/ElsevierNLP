'use strict';

var fs   = require('fs');
var path = require('path');

var MONTH_ABBR = {
  January:   'Jan', February:  'Feb', March:     'Mar', April:    'Apr',
  May:       'May', June:      'Jun', July:      'Jul', August:   'Aug',
  September: 'Sep', October:   'Oct', November:  'Nov', December: 'Dec',
};

function getTag(xml, tag) {
  var esc = tag.replace(':', '\\:');
  var re = new RegExp('<' + esc + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + esc + '>');
  var m = xml.match(re);
  return m ? m[1].trim() : '';
}

function getAllTags(xml, tag) {
  var esc = tag.replace(':', '\\:');
  var re = new RegExp('<' + esc + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + esc + '>', 'g');
  var out = [];
  var m;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

function formatISSN(raw) {
  if (!raw) return '';
  if (raw.indexOf('-') !== -1) return raw;
  var d = raw.replace(/\D/g, '');
  return d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4) : raw;
}

function formatAuthor(creator) {
  var commaIdx = creator.indexOf(',');
  if (commaIdx === -1) return creator.trim();
  var lastName  = creator.slice(0, commaIdx).trim();
  var firstPart = creator.slice(commaIdx + 1).trim();
  var tokens = firstPart.split(/\s+/).filter(Boolean);
  var initials = tokens.map(function(token) {
    if (/^(?:[A-Z]\.)+$/.test(token)) return token;
    if (token.indexOf('-') !== -1) {
      return token.split('-').map(function(p) {
        return p.charAt(0).toUpperCase() + '.';
      }).join('-');
    }
    return token.charAt(0).toUpperCase() + '.';
  });
  return lastName + ',' + initials.join('');
}

/**
 * Format a Consyn structured author (given-name + surname) into Surname,I.I. form.
 */
function formatConsynAuthor(givenName, surname) {
  var tokens = (givenName || '').trim().split(/\s+/).filter(Boolean);
  var initials = tokens.map(function(token) {
    // Already initials: "D." or "W.N." or "S.L."
    if (/^(?:[A-Z]\.)+$/.test(token)) return token;
    // Hyphenated first name: "Jean-Pierre" → "J.-P."
    if (token.indexOf('-') !== -1) {
      return token.split('-').map(function(p) {
        return p.charAt(0).toUpperCase() + '.';
      }).join('-');
    }
    return token.charAt(0).toUpperCase() + '.';
  });
  return (surname || '').trim() + ',' + initials.join('');
}

function toTitleCase(str) {
  return str.replace(/\w\S*/g, function(w) {
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

function normaliseJournal(name) {
  if (!name) return name;
  var stripped = name.replace(/[^a-zA-Z]/g, '');
  if (stripped.length > 0 && stripped === stripped.toUpperCase()) {
    return toTitleCase(name);
  }
  return name;
}

function xmlAttrVal(v) {
  return v
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function attr(name, value) {
  return '  <attr name="' + name + '" value="' + xmlAttrVal(value) + '" />';
}

/**
 * Get article title from sdxml.
 * Searches <ce:title> inside <xocs:serial-item> to avoid issue/section titles.
 * Falls back to <dc:title>.
 */
function getArticleTitle(xml) {
  var serialStart = xml.indexOf('<xocs:serial-item');
  var searchArea = serialStart !== -1 ? xml.slice(serialStart) : xml;
  var m = searchArea.match(/<ce:title(?:\s[^>]*)?>([^<]+)<\/ce:title>/);
  if (m && m[1].trim()) return m[1].trim();
  return getTag(xml, 'dc:title').replace(/\s+$/, '').trim();
}

function extractBodyText(xml) {
  var start = xml.indexOf('<xocs:serial-item');
  if (start === -1) {
    var metaEnd = xml.indexOf('</xocs:meta>');
    if (metaEnd !== -1) {
      start = metaEnd + '</xocs:meta>'.length;
    } else {
      start = xml.indexOf('<originalText>');
      if (start === -1) return '';
      start += '<originalText>'.length;
    }
  }
  var end = xml.lastIndexOf('</originalText>');
  if (end === -1) return '';
  var text = xml.slice(start, end);
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Extract body text from a Consyn XML file.
 * Body is enclosed in <ja:body>...</ja:body>.
 */
function extractConsynBodyText(xml) {
  var start = xml.indexOf('<ja:body');
  if (start === -1) return '';
  var end = xml.indexOf('</ja:body>');
  if (end === -1) return '';
  // skip to end of the opening tag
  var tagEnd = xml.indexOf('>', start);
  var text = xml.slice(tagEnd + 1, end);
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Build the shared <section> element from collected metadata + body.
 */
function buildSection(doi, pii, title, authors, issn, pubName, pubVersion,
                       pubYear, pubMonth, volume, issue, pageRange, bodyText) {
  var attrs = [];
  attrs.push(attr('PII',      pii));
  attrs.push(attr('DOI',      doi));
  attrs.push(attr('URL',      'http://dx.doi.org/' + doi));
  attrs.push(attr('Title',    title));
  if (authors)    attrs.push(attr('Authors',    authors));
  attrs.push(attr('ISSN',     issn));
  attrs.push(attr('Journal',  pubName));
  attrs.push(attr('PubTypes', 'Journal Article'));
  if (pubVersion) attrs.push(attr('PubVersion', pubVersion));
  if (pubYear)    attrs.push(attr('PubYear',    pubYear));
  if (pubMonth)   attrs.push(attr('PubMonth',   pubMonth));
  if (volume)     attrs.push(attr('Volume',     volume));
  if (issue)      attrs.push(attr('Issue',      issue));
  if (pageRange)  attrs.push(attr('Pages',      pageRange));

  return ' <section uri="info:doi/' + doi + '" type="body">\n'
       + attrs.join('\n') + '\n'
       + '  <text>' + bodyText + '</text>\n'
       + ' </section>';
}

function convertSdxmlToSection(sdxmlContent) {
  var x = sdxmlContent;
  var doi       = getTag(x, 'prism:doi');
  var pii       = getTag(x, 'pii');
  var title     = getArticleTitle(x);
  var creators  = getAllTags(x, 'dc:creator');
  var pubName   = normaliseJournal(getTag(x, 'prism:publicationName'));
  var volume    = getTag(x, 'prism:volume');
  var issueId   = getTag(x, 'prism:issueIdentifier');
  var pageRange = getTag(x, 'prism:pageRange');
  var coverDate = getTag(x, 'prism:coverDisplayDate');
  var issn      = getTag(x, 'xocs:issn-primary-formatted') || formatISSN(getTag(x, 'prism:issn'));
  var pubVersion = getTag(x, 'xocs:item-version-number');

  var pubYear = getTag(x, 'xocs:year-nav');
  if (!pubYear) {
    var ym = coverDate.match(/\d{4}/);
    if (ym) pubYear = ym[0];
  }

  var pubMonth = '';
  var monthNames = Object.keys(MONTH_ABBR);
  for (var i = 0; i < monthNames.length; i++) {
    if (coverDate.indexOf(monthNames[i]) !== -1) {
      pubMonth = MONTH_ABBR[monthNames[i]];
      break;
    }
  }

  var authors  = creators.map(formatAuthor).join(';');
  var bodyText = extractBodyText(x);

  return buildSection(doi, pii, title, authors, issn, pubName, pubVersion,
                      pubYear, pubMonth, volume, issueId, pageRange, bodyText);
}

/**
 * Convert a single Consyn XML file to a <section> element.
 * Consyn format: <doc:document> root with <rdf:RDF> metadata block,
 * <ja:article> body with structured <ce:author> elements and <ja:body>.
 */
function convertConsynToSection(consynContent) {
  var x = consynContent;

  // Metadata from <rdf:Description> block
  var doi       = getTag(x, 'prism:doi');
  var pii       = getTag(x, 'ce:pii');   // e.g. "S0001-2998(22)00073-3" — keep as-is
  var pubName   = normaliseJournal(getTag(x, 'prism:publicationName'));
  var issn      = formatISSN(getTag(x, 'prism:issn'));
  var volume    = getTag(x, 'prism:volume');
  var issue     = getTag(x, 'prism:number');
  var pageRange = getTag(x, 'prism:pageRange');
  var coverDate = getTag(x, 'prism:coverDisplayDate');
  var pubVersion = getTag(x, 'dp:version-number');

  // Title: prefer dct:title (clean text, no nested XML tags)
  var title = getTag(x, 'dct:title');
  if (!title) {
    // Fallback: ce:title in ja:head — strip any nested tags
    var headStart = x.indexOf('<ja:head>');
    var headEnd   = x.indexOf('</ja:head>');
    if (headStart !== -1 && headEnd !== -1) {
      var headXml = x.slice(headStart, headEnd);
      var tm = headXml.match(/<ce:title[^>]*>([\s\S]*?)<\/ce:title>/);
      if (tm) title = tm[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  // Year and month from coverDisplayDate
  var pubYear = '';
  var ydm = coverDate.match(/\d{4}/);
  if (ydm) pubYear = ydm[0];

  var pubMonth = '';
  var monthNames = Object.keys(MONTH_ABBR);
  for (var i = 0; i < monthNames.length; i++) {
    if (coverDate.indexOf(monthNames[i]) !== -1) {
      pubMonth = MONTH_ABBR[monthNames[i]];
      break;
    }
  }

  // Authors: structured <ce:author> with <ce:given-name> + <ce:surname>
  var authorBlocks = getAllTags(x, 'ce:author');
  var authorList = [];
  for (var j = 0; j < authorBlocks.length; j++) {
    var block = authorBlocks[j];
    var givenM   = block.match(/<ce:given-name[^>]*>([\s\S]*?)<\/ce:given-name>/);
    var surnameM = block.match(/<ce:surname[^>]*>([\s\S]*?)<\/ce:surname>/);
    if (surnameM) {
      var given   = givenM   ? givenM[1].replace(/<[^>]+>/g, '').trim() : '';
      var surname = surnameM[1].replace(/<[^>]+>/g, '').trim();
      authorList.push(formatConsynAuthor(given, surname));
    }
  }
  var authors = authorList.join(';');

  var bodyText = extractConsynBodyText(x);

  return buildSection(doi, pii, title, authors, issn, pubName, pubVersion,
                      pubYear, pubMonth, volume, issue, pageRange, bodyText);
}

/**
 * Recursively collect files from a directory.
 * When recursive=true, walks subdirectories.
 * Accepts .sdxml and .xml files; detects format by content root tag.
 */
function collectFiles(dir, recursive) {
  var results = [];
  var entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        var sub = collectFiles(fullPath, true);
        for (var k = 0; k < sub.length; k++) results.push(sub[k]);
      }
    } else {
      var lname = entry.name.toLowerCase();
      if (lname.endsWith('.sdxml') || lname.endsWith('.xml')) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function convertDirectory(inputDir, outputPath, onProgress, recursive) {
  var files = collectFiles(inputDir, !!recursive).sort();

  if (files.length === 0) {
    var msg = recursive
      ? 'No .sdxml or .xml files found in the input directory (searched recursively).'
      : 'No .sdxml or .xml files found in the input directory.';
    throw new Error(msg);
  }

  var sections = [];
  var errors   = [];

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var shortName = path.relative(inputDir, file);
    if (onProgress) onProgress(i + 1, files.length, shortName);
    try {
      var content = fs.readFileSync(file, 'utf8');
      // Detect format: Consyn files have <doc:document root tag
      var isConsyn = content.trimLeft().startsWith('<doc:document');
      if (isConsyn) {
        sections.push(convertConsynToSection(content));
      } else {
        sections.push(convertSdxmlToSection(content));
      }
    } catch (e) {
      errors.push({ file: shortName, error: e.message });
    }
  }

  var output = '<batch>\n' + sections.join('\n') + '\n</batch>';
  fs.writeFileSync(outputPath, output, 'utf8');
  return { converted: sections.length, errors: errors };
}

/**
 * Convert an explicit list of ScienceDirect (.sdxml / .xml) or Consyn files into ONE MSXML file.
 * Streams to disk (no giant in-memory string) and yields to the event loop regularly so the
 * Electron main process stays responsive on big batches.
 * @returns {Promise<{converted:number, errors:{file:string,error:string}[]}>}
 */
async function convertFiles(files, outputPath, onProgress) {
  var errors = [];
  var converted = 0;
  var fd = fs.openSync(outputPath, 'w');
  try {
    fs.writeSync(fd, '<batch>\n');
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (onProgress) onProgress(i + 1, files.length, path.basename(file));
      try {
        var content = fs.readFileSync(file, 'utf8');
        var section = content.trimLeft().startsWith('<doc:document')
          ? convertConsynToSection(content)
          : convertSdxmlToSection(content);
        fs.writeSync(fd, section + '\n');
        converted++;
      } catch (e) {
        errors.push({ file: path.basename(file), error: e.message });
      }
      if (i % 50 === 49) await new Promise(function (r) { setImmediate(r); });
    }
    fs.writeSync(fd, '</batch>');
  } finally {
    fs.closeSync(fd);
  }
  return { converted: converted, errors: errors };
}

module.exports = {
  convertDirectory:      convertDirectory,
  convertFiles:          convertFiles,
  convertSdxmlToSection: convertSdxmlToSection,
  convertConsynToSection: convertConsynToSection,
};
